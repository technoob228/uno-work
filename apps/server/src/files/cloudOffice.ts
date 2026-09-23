/**
 * Word/Excel/PowerPoint documents that live in Cloud storage, opened in
 * Office and saved back there — the computer's disk only holds them for the
 * moment it takes to hand the bytes to the browser.
 *
 * - Open: the daemon downloads the object (presigned GET, S3 keys stay in
 *   the console), stages it in a hidden folder in the home for the page to
 *   read, and tells the page its version (sha256 prefix of the bytes).
 * - Save: the page stages the new bytes the same way; the daemon downloads
 *   the current object again and compares versions. Someone else saved
 *   meanwhile (another computer, another tab, an upload in Files) → conflict,
 *   nothing is overwritten. Otherwise the current object is kept as a version
 *   under `<folder>/.versions/<name>/` (last {@link CLOUD_OFFICE_KEEP_VERSIONS})
 *   and the new bytes replace it.
 *
 * The version is our own content hash, not the S3 ETag: a presigned GET is
 * the one thing every console gives us, and hashing what we download can't
 * disagree with what the page opened.
 *
 * @module files/cloudOffice
 */
import { randomBytes } from "node:crypto";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import {
  CloudError,
  cloudDelete,
  cloudList,
  cloudPresign,
  type CloudDeps,
} from "./cloudStorage.ts";
import {
  contentVersion,
  looksLikeOfficeArchive,
  officeShareInfo,
  SHARE_OFFICE_MAX_BYTES,
} from "./shareOffice.ts";

/** Older copies kept next to a Cloud document (they count toward the quota). */
export const CLOUD_OFFICE_KEEP_VERSIONS = 10;
/** Hidden folder in the home where bytes wait between the page and the cloud. */
export const CLOUD_OFFICE_STAGING_DIR = ".uno-office-cloud";

export interface CloudOfficeOpened {
  readonly stagedPath: string;
  readonly version: string;
  readonly name: string;
  readonly size: number;
  /** False for formats Office can only read (doc/xls/ppt): no saving back. */
  readonly writable: boolean;
}

export type CloudOfficeSaveResult =
  | { readonly kind: "saved"; readonly version: string }
  | { readonly kind: "conflict"; readonly currentVersion: string | null };

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** Where the older copies of `key` live: `<folder>/.versions/<name>/`. */
export function cloudVersionsPrefix(key: string): string {
  const slash = key.lastIndexOf("/");
  return `${key.slice(0, slash + 1)}.versions/${key.slice(slash + 1)}/`;
}

function versionStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function checkKey(key: string) {
  const info = officeShareInfo(nameOf(key));
  if (!info || key.endsWith("/")) throw new CloudError("Office can't open this file.");
  if (key.split("/").includes(".versions")) {
    throw new CloudError("This is an older copy. Download it, or copy it to this computer.");
  }
  return info;
}

async function download(
  deps: CloudDeps,
  bucketId: number,
  key: string,
): Promise<Uint8Array | null> {
  const url = await cloudPresign(deps, bucketId, key, "get");
  const response = await (deps.fetchImpl ?? fetch)(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CloudError(`Cloud storage answered ${response.status} for “${nameOf(key)}”.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > SHARE_OFFICE_MAX_BYTES) {
    throw new CloudError("This document is too large to open in the browser (over 60 MB).");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > SHARE_OFFICE_MAX_BYTES) {
    throw new CloudError("This document is too large to open in the browser (over 60 MB).");
  }
  return bytes;
}

async function upload(deps: CloudDeps, bucketId: number, key: string, bytes: Uint8Array) {
  const url = await cloudPresign(deps, bucketId, key, "put");
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: "PUT",
    body: bytes as unknown as RequestInit["body"],
    headers: { "content-length": String(bytes.length) },
  });
  if (response.status === 402 || response.status === 403) {
    throw new CloudError(
      "Cloud storage is full or doesn't accept this upload. Nothing was changed.",
    );
  }
  if (!response.ok) {
    throw new CloudError(`Saving to Cloud storage failed (storage answered ${response.status}).`);
  }
}

/** Anything left in the staging folder for more than an hour (a closed tab). */
export async function sweepCloudOfficeStaging(homeDir: string, now = Date.now()): Promise<void> {
  const root = nodePath.join(homeDir, CLOUD_OFFICE_STAGING_DIR);
  const entries = await fsPromises.readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    const path = nodePath.join(root, entry);
    const stats = await fsPromises.lstat(path).catch(() => null);
    if (stats && now - stats.mtimeMs > 60 * 60 * 1000) {
      await fsPromises.rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Download a Cloud document into the staging folder for the page to read. */
export async function openCloudOffice(
  deps: CloudDeps,
  input: { readonly bucketId: number; readonly key: string; readonly homeDir: string },
): Promise<CloudOfficeOpened> {
  const info = checkKey(input.key);
  await sweepCloudOfficeStaging(input.homeDir);
  const bytes = await download(deps, input.bucketId, input.key);
  if (bytes === null) throw new CloudError("This document isn't in Cloud storage anymore.");
  const name = nameOf(input.key);
  const dir = nodePath.join(
    input.homeDir,
    CLOUD_OFFICE_STAGING_DIR,
    randomBytes(6).toString("hex"),
  );
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  const stagedPath = nodePath.join(dir, name);
  await fsPromises.writeFile(stagedPath, bytes, { mode: 0o600 });
  return {
    stagedPath,
    version: contentVersion(bytes),
    name,
    size: bytes.length,
    writable: info.writable,
  };
}

const locks = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Drops all but the newest {@link CLOUD_OFFICE_KEEP_VERSIONS} older copies. Best effort. */
async function pruneVersions(deps: CloudDeps, bucketId: number, key: string) {
  const listing = await cloudList(deps, { bucketId, prefix: cloudVersionsPrefix(key) });
  if (!listing.listingSupported) return;
  const keys = listing.objects.map((object) => object.key).toSorted();
  for (const stale of keys.slice(0, Math.max(0, keys.length - CLOUD_OFFICE_KEEP_VERSIONS))) {
    await cloudDelete(deps, bucketId, stale);
  }
}

/**
 * Put `bytes` in place of the Cloud document `key`, keeping the current
 * content as an older copy. `baseVersion` is what the page opened; a
 * different current version is a conflict unless `force`.
 */
export async function saveCloudOffice(
  deps: CloudDeps,
  input: {
    readonly bucketId: number;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly baseVersion: string | null;
    readonly force: boolean;
    readonly now?: Date;
  },
): Promise<CloudOfficeSaveResult> {
  const info = checkKey(input.key);
  if (!info.writable) {
    throw new CloudError(
      `Old .${info.extension} files can't be saved back. Copy it to this computer to convert it.`,
    );
  }
  if (input.bytes.length === 0 || input.bytes.length > SHARE_OFFICE_MAX_BYTES) {
    throw new CloudError("The document is too large to save (over 60 MB).");
  }
  if (!looksLikeOfficeArchive(input.bytes)) {
    throw new CloudError("That isn't a document the editor made.");
  }
  return withKeyLock(`${input.bucketId}:${input.key}`, async () => {
    const current = await download(deps, input.bucketId, input.key);
    const currentVersion = current === null ? null : contentVersion(current);
    if (!input.force && currentVersion !== input.baseVersion) {
      return { kind: "conflict", currentVersion } as const;
    }
    const newVersion = contentVersion(input.bytes);
    if (current !== null && currentVersion !== newVersion) {
      const ext = info.extension;
      const stamp = versionStamp(input.now ?? new Date());
      await upload(
        deps,
        input.bucketId,
        `${cloudVersionsPrefix(input.key)}${stamp}.${ext}`,
        current,
      );
    }
    await upload(deps, input.bucketId, input.key, input.bytes);
    await pruneVersions(deps, input.bucketId, input.key).catch(() => undefined);
    return { kind: "saved", version: newVersion } as const;
  });
}
