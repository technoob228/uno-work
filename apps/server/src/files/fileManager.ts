/**
 * File-manager operations behind the Files app: list, stat, create folder,
 * rename, move, delete, search. Plain async functions over `node:fs` taking the
 * already-resolved root; every incoming path goes through `resolveInsideRoot`.
 *
 * @module files/fileManager
 */
import type { Dirent, Stats } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import type {
  FilesConflictPolicy,
  FilesEntry,
  FilesListResult,
  FilesSearchResult,
} from "@t3tools/contracts";

import {
  FilesPathError,
  isHiddenPath,
  isSameOrInside,
  resolveInsideRoot,
  uniqueDestination,
  validateEntryName,
} from "./filesPaths.ts";

/** Folders a name search never walks into: noise, not documents. */
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
const SEARCH_DEFAULT_LIMIT = 200;
const SEARCH_MAX_VISITED = 50_000;
const SEARCH_BUDGET_MS = 2_500;

function toEntry(rootReal: string, fullPath: string, stats: Stats, isSymlink: boolean): FilesEntry {
  const isDirectory = stats.isDirectory();
  return {
    name: nodePath.basename(fullPath),
    path: fullPath,
    kind: isDirectory ? "directory" : "file",
    size: isDirectory ? 0 : Math.max(0, Math.trunc(stats.size)),
    modifiedAt: stats.mtime.toISOString(),
    hidden: isHiddenPath(rootReal, fullPath),
    isSymlink,
  };
}

/** Entry for a path that is already resolved inside the root. */
export async function statResolved(rootReal: string, resolved: string): Promise<FilesEntry> {
  const stats = await fsPromises.stat(resolved);
  return toEntry(rootReal, resolved, stats, false);
}

async function entryForDirent(
  rootReal: string,
  directory: string,
  dirent: Dirent,
): Promise<FilesEntry | null> {
  const fullPath = nodePath.join(directory, dirent.name);
  try {
    if (dirent.isSymbolicLink()) {
      // Show the link as what it points to; a dangling link is left out.
      const stats = await fsPromises.stat(fullPath);
      return toEntry(rootReal, fullPath, stats, true);
    }
    if (!dirent.isFile() && !dirent.isDirectory()) return null; // sockets, fifos, devices
    const stats = await fsPromises.lstat(fullPath);
    return toEntry(rootReal, fullPath, stats, false);
  } catch {
    return null;
  }
}

function sortEntries(entries: FilesEntry[]): FilesEntry[] {
  return entries.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export async function listFolder(
  rootReal: string,
  input: { readonly path?: string | undefined; readonly showHidden?: boolean | undefined },
): Promise<FilesListResult> {
  const directory = await resolveInsideRoot(rootReal, input.path ?? rootReal);
  const stats = await fsPromises.stat(directory);
  if (!stats.isDirectory()) {
    throw new FilesPathError("not_a_folder", "This is a file, not a folder.");
  }
  let dirents: Dirent[];
  try {
    dirents = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new FilesPathError(
      "forbidden",
      `Can't open this folder${cause instanceof Error && "code" in cause ? ` (${String((cause as NodeJS.ErrnoException).code)})` : ""}.`,
    );
  }
  const visible = input.showHidden
    ? dirents
    : dirents.filter((dirent) => !dirent.name.startsWith("."));
  const entries = (
    await Promise.all(visible.map((dirent) => entryForDirent(rootReal, directory, dirent)))
  ).filter((entry): entry is FilesEntry => entry !== null);
  return {
    path: directory,
    rootPath: rootReal,
    parentPath: directory === rootReal ? null : nodePath.dirname(directory),
    entries: sortEntries(entries),
  };
}

export async function statPath(rootReal: string, target: string): Promise<FilesEntry> {
  return statResolved(rootReal, await resolveInsideRoot(rootReal, target));
}

export async function createFolder(
  rootReal: string,
  input: { readonly parentPath: string; readonly name: string },
): Promise<FilesEntry> {
  const name = validateEntryName(input.name);
  const parent = await resolveInsideRoot(rootReal, input.parentPath);
  const destination = nodePath.join(parent, name);
  try {
    await fsPromises.mkdir(destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FilesPathError("exists", `“${name}” already exists here.`);
    }
    throw cause;
  }
  return statResolved(rootReal, destination);
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fsPromises.stat(left), fsPromises.stat(right)]);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Rename across devices: copy, then remove the original. */
async function renameOrCopy(source: string, destination: string): Promise<void> {
  try {
    await fsPromises.rename(source, destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    await fsPromises.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await fsPromises.rm(source, { recursive: true, force: true });
  }
}

/**
 * Put `source` at `destination` honouring the conflict policy. Returns the
 * path it actually landed at (differs under `keepBoth`).
 */
async function placeAt(
  source: string,
  destination: string,
  onConflict: FilesConflictPolicy,
): Promise<string> {
  if (source === destination) return destination;
  // Case-only rename on a case-insensitive disk: the "existing" file is itself.
  if ((await pathExists(destination)) && !(await sameFile(source, destination))) {
    const name = nodePath.basename(destination);
    if (onConflict === "fail") {
      throw new FilesPathError("exists", `“${name}” already exists here.`);
    }
    if (onConflict === "keepBoth") {
      const free = await uniqueDestination(nodePath.dirname(destination), name);
      await renameOrCopy(source, free);
      return free;
    }
    const [sourceStats, destinationStats] = await Promise.all([
      fsPromises.stat(source),
      fsPromises.stat(destination),
    ]);
    if (sourceStats.isDirectory() || destinationStats.isDirectory()) {
      throw new FilesPathError(
        "exists",
        `“${name}” already exists here, and folders can't be replaced. Rename one of them first.`,
      );
    }
    // rename(2) over an existing file is atomic: readers see old or new, never half.
  }
  await renameOrCopy(source, destination);
  return destination;
}

export async function renameEntry(
  rootReal: string,
  input: {
    readonly path: string;
    readonly newName: string;
    readonly onConflict?: FilesConflictPolicy | undefined;
  },
): Promise<{ readonly from: string; readonly entry: FilesEntry }> {
  const name = validateEntryName(input.newName);
  const source = await resolveInsideRoot(rootReal, input.path);
  if (source === rootReal) {
    throw new FilesPathError("forbidden", "The home folder can't be renamed.");
  }
  const destination = nodePath.join(nodePath.dirname(source), name);
  const landed = await placeAt(source, destination, input.onConflict ?? "fail");
  return { from: source, entry: await statResolved(rootReal, landed) };
}

export async function moveEntries(
  rootReal: string,
  input: {
    readonly paths: ReadonlyArray<string>;
    readonly destinationPath: string;
    readonly onConflict?: FilesConflictPolicy | undefined;
  },
): Promise<ReadonlyArray<{ readonly from: string; readonly entry: FilesEntry }>> {
  const destinationDir = await resolveInsideRoot(rootReal, input.destinationPath);
  if (!(await fsPromises.stat(destinationDir)).isDirectory()) {
    throw new FilesPathError("not_a_folder", "Items can only be moved into a folder.");
  }
  const moved: Array<{ from: string; entry: FilesEntry }> = [];
  for (const rawPath of input.paths) {
    const source = await resolveInsideRoot(rootReal, rawPath);
    if (source === rootReal) {
      throw new FilesPathError("forbidden", "The home folder can't be moved.");
    }
    if (isSameOrInside(destinationDir, source)) {
      throw new FilesPathError(
        "forbidden",
        `“${nodePath.basename(source)}” can't be moved into itself.`,
      );
    }
    if (nodePath.dirname(source) === destinationDir) {
      moved.push({ from: source, entry: await statResolved(rootReal, source) });
      continue;
    }
    const landed = await placeAt(
      source,
      nodePath.join(destinationDir, nodePath.basename(source)),
      input.onConflict ?? "keepBoth",
    );
    moved.push({ from: source, entry: await statResolved(rootReal, landed) });
  }
  return moved;
}

export async function deleteEntries(
  rootReal: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const resolved: string[] = [];
  for (const rawPath of paths) {
    const target = await resolveInsideRoot(rootReal, rawPath);
    if (target === rootReal) {
      throw new FilesPathError("forbidden", "The home folder can't be deleted.");
    }
    resolved.push(target);
  }
  for (const target of resolved) {
    await fsPromises.rm(target, { recursive: true, force: true });
  }
  return resolved;
}

export async function searchByName(
  rootReal: string,
  input: {
    readonly path?: string | undefined;
    readonly query: string;
    readonly showHidden?: boolean | undefined;
    readonly limit?: number | undefined;
  },
): Promise<FilesSearchResult> {
  const start = await resolveInsideRoot(rootReal, input.path ?? rootReal);
  const needle = input.query.trim().toLocaleLowerCase();
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const results: FilesEntry[] = [];
  const queue: string[] = [start];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (results.length >= limit || visited >= SEARCH_MAX_VISITED || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const directory = queue.shift()!;
    let dirents: Dirent[];
    try {
      dirents = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      visited += 1;
      if (!input.showHidden && dirent.name.startsWith(".")) continue;
      const fullPath = nodePath.join(directory, dirent.name);
      // Real folders only: following symlinked folders could loop or leave the root.
      if (dirent.isDirectory() && !SEARCH_SKIP_DIRS.has(dirent.name)) queue.push(fullPath);
      if (!dirent.name.toLocaleLowerCase().includes(needle)) continue;
      const entry = await entryForDirent(rootReal, directory, dirent);
      if (entry) results.push(entry);
      if (results.length >= limit) break;
    }
  }

  return { entries: sortEntries(results), truncated };
}
