/**
 * What an agent's answer names as a file, turned into a real file of this
 * computer: the chat asks, in batches, and only what exists becomes a chip
 * that opens in the right panel. `~` and the chat's folder are the computer's
 * own, which is why this is decided here and not in the client (the chat may
 * run on another computer than the one showing it).
 *
 * A mention is tried, in order:
 *   1. as written: `~/x`, an absolute path;
 *   2. from the chat's folder, then from the folders above it (agents write
 *      paths from the repository's root, the chat may sit in a subfolder),
 *      then from the home folder;
 *   3. anywhere under the chat's folder, by its tail (`index.html` is
 *      `web/index.html`): a bounded walk, the shallowest match wins.
 *
 * Files anywhere count: the panel reads them the way `filesystem.readFile`
 * does, which isn't limited to the files root. Folders only inside the root:
 * they open in Files, which goes no further.
 */
import type { Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import type {
  FilesEntryKind,
  FilesResolveMentionsInput,
  FilesResolveMentionsResult,
  FilesResolvedMention,
} from "@t3tools/contracts";

import { SEARCH_SKIP_DIRS } from "./fileManager.ts";
import { isSameOrInside } from "./filesPaths.ts";

/** Folders above the chat's that a relative mention may start from. */
const MAX_FOLDERS_UP = 4;
/** Build output repeats a project's file names: never the file that was meant. */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  ...SEARCH_SKIP_DIRS,
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
]);
const WALK_MAX_DEPTH = 8;
const WALK_MAX_VISITED = 20_000;
const WALK_BUDGET_MS = 300;

type Found = { readonly path: string; readonly kind: FilesEntryKind };

async function statKind(path: string): Promise<FilesEntryKind | null> {
  try {
    const stats = await fsPromises.stat(path);
    if (stats.isFile()) return "file";
    return stats.isDirectory() ? "directory" : null;
  } catch {
    return null;
  }
}

function startFolders(rootReal: string, cwd: string | undefined): string[] {
  const folders: string[] = [];
  if (cwd && nodePath.isAbsolute(cwd)) {
    let folder = nodePath.normalize(cwd);
    for (let up = 0; up <= MAX_FOLDERS_UP; up += 1) {
      folders.push(folder);
      const parent = nodePath.dirname(folder);
      if (folder === rootReal || parent === folder) break;
      folder = parent;
    }
  }
  if (!folders.includes(rootReal)) folders.push(rootReal);
  return folders;
}

function pathsToTry(mention: string, rootReal: string, folders: ReadonlyArray<string>): string[] {
  if (mention === "~") return [rootReal];
  if (mention.startsWith("~/")) return [nodePath.join(rootReal, mention.slice(2))];
  if (nodePath.isAbsolute(mention)) return [nodePath.normalize(mention)];
  return folders.map((folder) => nodePath.resolve(folder, mention));
}

async function resolveDirectly(
  mention: string,
  rootReal: string,
  folders: ReadonlyArray<string>,
): Promise<Found | null> {
  const wantsFolder = mention.endsWith("/");
  for (const path of pathsToTry(mention, rootReal, folders)) {
    const kind = await statKind(path);
    if (kind === null) continue;
    if (kind === "directory" && !isSameOrInside(path, rootReal)) continue;
    if (kind === "file" && wantsFolder) continue;
    return { path, kind };
  }
  return null;
}

/** Only a plain relative tail can be looked for: `report.md`, `web/index.html`. */
function walkTail(mention: string): string | null {
  if (mention.startsWith("~") || mention.endsWith("/")) return null;
  if (nodePath.isAbsolute(mention)) return null;
  const tail = mention.replace(/^\.\//, "");
  return tail.split("/").includes("..") ? null : tail;
}

/** Breadth first, so the first match of a tail is the shallowest one. */
async function findByTail(
  start: string,
  tails: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  const names = new Set([...tails].map((tail) => nodePath.posix.basename(tail)));
  const deadline = Date.now() + WALK_BUDGET_MS;
  const queue: Array<{ folder: string; depth: number }> = [{ folder: start, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && found.size < tails.size) {
    if (visited >= WALK_MAX_VISITED || Date.now() > deadline) break;
    const { folder, depth } = queue.shift()!;
    let dirents: Dirent[];
    try {
      dirents = await fsPromises.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    // readdir's order is the disk's: the same answer on every computer.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      visited += 1;
      const full = nodePath.join(folder, dirent.name);
      if (dirent.isDirectory()) {
        if (
          depth < WALK_MAX_DEPTH &&
          !dirent.name.startsWith(".") &&
          !WALK_SKIP_DIRS.has(dirent.name)
        ) {
          queue.push({ folder: full, depth: depth + 1 });
        }
        continue;
      }
      if (!dirent.isFile() || !names.has(dirent.name)) continue;
      for (const tail of tails) {
        if (found.has(tail)) continue;
        if (full.endsWith(`${nodePath.sep}${tail.split("/").join(nodePath.sep)}`)) {
          found.set(tail, full);
        }
      }
    }
  }
  return found;
}

export async function resolveFileMentions(
  rootReal: string,
  input: FilesResolveMentionsInput,
): Promise<FilesResolveMentionsResult> {
  const folders = startFolders(rootReal, input.cwd);
  const mentions = [...new Set(input.mentions)];
  const direct = await Promise.all(
    mentions.map((mention) => resolveDirectly(mention, rootReal, folders)),
  );

  const tails = new Set<string>();
  mentions.forEach((mention, index) => {
    const tail = direct[index] ? null : walkTail(mention);
    if (tail) tails.add(tail);
  });
  const walked =
    tails.size > 0 ? await findByTail(folders[0] ?? rootReal, tails) : new Map<string, string>();

  const byMention = new Map<string, FilesResolvedMention>();
  mentions.forEach((mention, index) => {
    const found = direct[index];
    const tail = walkTail(mention);
    const walkedPath = tail ? walked.get(tail) : undefined;
    byMention.set(mention, {
      mention,
      path: found?.path ?? walkedPath ?? null,
      kind: found?.kind ?? (walkedPath ? "file" : null),
    });
  });
  return { results: mentions.map((mention) => byMention.get(mention)!) };
}
