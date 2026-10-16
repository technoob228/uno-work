/**
 * Older copies of cloud files: `<folder>/.versions/<name>/<time>.<ext>` in the
 * same bucket, newest last by key. Office writes one on every save of a Cloud
 * document (cloudOffice.ts) and lists them in Office → Versions
 * (officeVersions.ts); a copy from the computer that replaces a file in the
 * cloud (Files, `drive_save`) keeps the replaced object the same way
 * (cloudStorage.ts). Files and Uno Drive hide the folder; the copies count
 * toward the account's cloud space.
 *
 * Naming and pruning rules only — no I/O here.
 *
 * @module files/cloudVersions
 */

/** The hidden folder next to a file that holds its older copies. */
export const CLOUD_VERSIONS_FOLDER = ".versions";
/** Older copies kept per file; the oldest go first. */
export const CLOUD_KEEP_VERSIONS = 10;
/** A replaced file bigger than this isn't kept (one copy of a video would eat the space). */
export const CLOUD_VERSION_MAX_BYTES = 200 * 1024 * 1024;
/**
 * Replaced files kept per copy to the cloud: re-uploading a whole project
 * folder shouldn't double its traffic and space; the rest is replaced as is.
 */
export const CLOUD_VERSIONS_PER_TRANSFER = 50;

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** Where the older copies of `key` live: `<folder>/.versions/<name>/`. */
export function cloudVersionsPrefix(key: string): string {
  const slash = key.lastIndexOf("/");
  return `${key.slice(0, slash + 1)}${CLOUD_VERSIONS_FOLDER}/${key.slice(slash + 1)}/`;
}

/** True for a key inside some `.versions/` folder (an older copy itself). */
export function isCloudVersionKey(key: string): boolean {
  return key.split("/").includes(CLOUD_VERSIONS_FOLDER);
}

/** `2026-09-24T10-00-00-000Z`: an ISO time made file-name safe (sorts by time). */
export function cloudVersionStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** The extension of a file name, without the dot ("" for none or a dotfile). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
}

/**
 * The key the current content of `key` is kept under when replaced at `now`:
 * `<folder>/.versions/<name>/<stamp>.<ext>` (`ext` defaults to the name's).
 */
export function cloudVersionKey(key: string, now: Date, extension?: string): string {
  const ext = extension ?? extensionOf(nameOf(key));
  return `${cloudVersionsPrefix(key)}${cloudVersionStamp(now)}${ext ? `.${ext}` : ""}`;
}

/** Copies to delete so that only the newest `keep` remain (keys sort by time). */
export function staleCloudVersions(
  keys: ReadonlyArray<string>,
  keep: number = CLOUD_KEEP_VERSIONS,
): string[] {
  const sorted = keys.toSorted();
  return sorted.slice(0, Math.max(0, sorted.length - Math.max(0, keep)));
}

/**
 * Why the file `key` (`size` bytes) that is about to be replaced isn't kept
 * as an older copy, or null when it is; `keptSoFar` counts the copies kept
 * earlier in the same transfer.
 */
export function cloudVersionSkipReason(
  key: string,
  size: number,
  keptSoFar: number,
): string | null {
  if (isCloudVersionKey(key)) return "it is an older copy itself";
  if (size > CLOUD_VERSION_MAX_BYTES) {
    return `older copies are kept for files up to ${CLOUD_VERSION_MAX_BYTES / 1024 / 1024} MB`;
  }
  if (keptSoFar >= CLOUD_VERSIONS_PER_TRANSFER) {
    return `older copies are kept for the first ${CLOUD_VERSIONS_PER_TRANSFER} replaced files of one copy`;
  }
  return null;
}
