/**
 * "Versions" in Office: the older copies of the open document, newest first.
 *
 * - A Cloud document: `<folder>/.versions/<name>/<time>.<ext>` in its bucket
 *   (written by cloudOffice.ts). Downloaded through a presigned link.
 * - A file on the computer: what share-link saves kept in
 *   `<baseDir>/share-versions/<shareId>/<time>--<name>` (shareOffice.ts), for
 *   every link that ever pointed at this file. Downloaded through the owner's
 *   HTTP route; the id is `<shareId>/<file>` and is only accepted for a link
 *   of that same file.
 *
 * @module files/officeVersions
 */
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import { cloudVersionsPrefix } from "./cloudOffice.ts";
import { cloudList, type CloudDeps } from "./cloudStorage.ts";

export interface OfficeVersion {
  /** Cloud: the object key. Computer: `<shareId>/<file>`. */
  readonly id: string;
  /** When it stopped being the current version (it was replaced then). */
  readonly createdAt: string | null;
  readonly size: number;
}

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

/** `2026-09-24T10-00-00-000Z…` (a stamp made file-name safe) → ISO time. */
export function versionStampToIso(name: string): string | null {
  const match = STAMP.exec(name);
  if (!match) return null;
  const [, day, hours, minutes, seconds, millis] = match;
  return `${day}T${hours}:${minutes}:${seconds}.${millis}Z`;
}

const newestFirst = (left: OfficeVersion, right: OfficeVersion) =>
  (right.createdAt ?? "").localeCompare(left.createdAt ?? "");

export async function listCloudOfficeVersions(
  deps: CloudDeps,
  input: { readonly bucketId: number; readonly key: string },
): Promise<OfficeVersion[]> {
  const listing = await cloudList(deps, {
    bucketId: input.bucketId,
    prefix: cloudVersionsPrefix(input.key),
  });
  return listing.objects
    .map((object) => ({
      id: object.key,
      createdAt: versionStampToIso(object.name) ?? object.modifiedAt,
      size: object.size,
    }))
    .toSorted(newestFirst);
}

/** A share-version file name we wrote: `<stamp>--<name>`, nothing that walks. */
function isVersionFileName(file: string): boolean {
  return (
    file.length > 0 &&
    !file.includes("/") &&
    !file.includes("\\") &&
    file !== "." &&
    file !== ".." &&
    STAMP.test(file) &&
    file.includes("--")
  );
}

export async function listShareOfficeVersions(input: {
  readonly versionsDir: string;
  readonly shareIds: ReadonlyArray<string>;
}): Promise<OfficeVersion[]> {
  const out: OfficeVersion[] = [];
  for (const shareId of input.shareIds) {
    const dir = nodePath.join(input.versionsDir, shareId);
    const files = await fsPromises.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!isVersionFileName(file)) continue;
      const stats = await fsPromises.stat(nodePath.join(dir, file)).catch(() => null);
      if (!stats?.isFile()) continue;
      out.push({ id: `${shareId}/${file}`, createdAt: versionStampToIso(file), size: stats.size });
    }
  }
  return out.toSorted(newestFirst);
}

/**
 * The file behind a computer version id, or null when the id isn't one of
 * `shareIds` (the links of the file being asked about) or isn't ours.
 */
export function resolveShareOfficeVersion(input: {
  readonly versionsDir: string;
  readonly shareIds: ReadonlyArray<string>;
  readonly id: string;
}): string | null {
  const slash = input.id.indexOf("/");
  if (slash <= 0) return null;
  const shareId = input.id.slice(0, slash);
  const file = input.id.slice(slash + 1);
  if (!input.shareIds.includes(shareId) || !isVersionFileName(file)) return null;
  return nodePath.join(input.versionsDir, shareId, file);
}
