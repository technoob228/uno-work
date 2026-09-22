/**
 * Path rules for the Files app.
 *
 * Everything the file manager touches must live inside one root (the Work
 * user's home). A path is accepted only if it is absolute, lexically inside the
 * root after normalization, AND its `realpath` (or its parent's, for a path that
 * does not exist yet) is inside the root's `realpath` — so neither `..` nor a
 * symlink planted inside the home can reach `/etc` or another user's files.
 *
 * @module files/filesPaths
 */
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

export type FilesPathErrorCode =
  | "invalid_path"
  | "outside_root"
  | "not_found"
  | "invalid_name"
  | "exists"
  | "not_a_folder"
  | "not_a_file"
  | "forbidden";

/** A user-facing refusal; `message` is safe to show in the UI. */
export class FilesPathError extends Error {
  readonly code: FilesPathErrorCode;

  constructor(code: FilesPathErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FilesPathError";
  }
}

const NAME_MAX_BYTES = 255;

/** True when `candidate` is `root` itself or strictly inside it (both normalized). */
export function isSameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`;
  return candidate.startsWith(prefix);
}

/**
 * A single file or folder name typed by a person: no separators, no NUL, not
 * `.`/`..`, at most 255 bytes. Returns the name unchanged (we don't silently
 * rewrite what the user typed).
 */
export function validateEntryName(name: string): string {
  if (name.length === 0 || name.trim().length === 0) {
    throw new FilesPathError("invalid_name", "Give it a name.");
  }
  if (name === "." || name === "..") {
    throw new FilesPathError("invalid_name", "That name is reserved. Pick another one.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\u0000")) {
    throw new FilesPathError("invalid_name", "Names can't contain “/” or “\\”.");
  }
  if (Buffer.byteLength(name, "utf8") > NAME_MAX_BYTES) {
    throw new FilesPathError("invalid_name", "That name is too long.");
  }
  return name;
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(target);
  } catch {
    return null;
  }
}

/** The root, resolved once: callers pass the result to every other helper. */
export async function resolveFilesRoot(root: string): Promise<string> {
  const real = await realpathOrNull(nodePath.resolve(root));
  if (!real) throw new FilesPathError("not_found", "The home folder is missing.");
  return real;
}

/**
 * Resolve a user-supplied absolute path inside `rootReal` (already a realpath).
 *
 * `mustExist: true` (default): the path must exist; the returned path is its
 * realpath. `mustExist: false`: the parent must exist inside the root and the
 * returned path is `realpath(parent)/basename` — for creating things.
 */
export async function resolveInsideRoot(
  rootReal: string,
  candidate: string,
  options: { readonly mustExist?: boolean } = {},
): Promise<string> {
  const mustExist = options.mustExist ?? true;
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    throw new FilesPathError("invalid_path", "That path isn't valid.");
  }
  if (!nodePath.isAbsolute(candidate)) {
    throw new FilesPathError("invalid_path", "That path isn't valid.");
  }
  const lexical = nodePath.resolve(candidate);
  if (!isSameOrInside(lexical, rootReal)) {
    throw new FilesPathError("outside_root", "Files can only open things inside your home folder.");
  }

  const real = await realpathOrNull(lexical);
  if (real !== null) {
    if (!isSameOrInside(real, rootReal)) {
      throw new FilesPathError(
        "outside_root",
        "This item points outside your home folder, so Files won't open it.",
      );
    }
    return real;
  }
  if (mustExist) {
    throw new FilesPathError("not_found", "This file or folder no longer exists.");
  }

  const parentReal = await realpathOrNull(nodePath.dirname(lexical));
  if (parentReal === null) {
    throw new FilesPathError("not_found", "The folder it should go into no longer exists.");
  }
  if (!isSameOrInside(parentReal, rootReal)) {
    throw new FilesPathError("outside_root", "Files can only open things inside your home folder.");
  }
  return nodePath.join(parentReal, nodePath.basename(lexical));
}

/** A dotfile, or anything inside a dot-folder, relative to the root. */
export function isHiddenPath(rootReal: string, target: string): boolean {
  const relative = nodePath.relative(rootReal, target);
  if (relative.length === 0) return false;
  return relative.split(nodePath.sep).some((segment) => segment.startsWith("."));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** `report.docx` → `report (2).docx`, `report (3).docx`, … until free. */
export function numberedName(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return `${base} (${attempt})${extension}`;
}

export async function uniqueDestination(directory: string, name: string): Promise<string> {
  const first = nodePath.join(directory, name);
  if (!(await exists(first))) return first;
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    const candidate = nodePath.join(directory, numberedName(name, attempt));
    if (!(await exists(candidate))) return candidate;
  }
  throw new FilesPathError("exists", "Couldn't find a free name for this item.");
}
