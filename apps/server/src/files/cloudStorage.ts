/**
 * Cloud storage — the Uno account's S3 buckets as a second disk in Files.
 *
 * Every call goes to the console with this computer's own token (the
 * work-machine token: boxes:* today, storage:* once minted). S3 keys never
 * leave the console: bytes move through presigned URLs it signs for one hour,
 * streamed straight between the disk and S3 by the daemon — the browser only
 * ever gets a presigned GET to download from.
 *
 * @module files/cloudStorage
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  FilesCloudBucket,
  FilesCloudListResult,
  FilesCloudState,
  FilesCloudTransferResult,
  FilesCloudUploadStepInput,
  FilesCloudUploadStepResult,
} from "@t3tools/contracts";
import { DRIVE_GIT_ROOT } from "@t3tools/shared/unoDrive";

import {
  ControlPlaneHttpError,
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";
import {
  CloudUploadError,
  type UploadSource,
  fileUploadSource,
  streamUploadSource,
  uploadToBucket,
} from "./cloudUpload.ts";
import {
  CLOUD_VERSIONS_FOLDER,
  cloudVersionKey,
  cloudVersionSkipReason,
  cloudVersionsPrefix,
  isCloudVersionKey,
  staleCloudVersions,
} from "./cloudVersions.ts";
import { ensureDiskSpace } from "./diskSpace.ts";
import { FilesPathError, uniqueDestination } from "./filesPaths.ts";

export { CLOUD_VERSIONS_FOLDER };

const PRESIGN_TTL_SECONDS = 3600;
const TRANSFER_MAX_FILES = 2000;

export type ControlPlaneFetch = (
  token: string,
  path: string,
  init?: RequestInit,
) => Promise<unknown>;

export interface CloudDeps {
  readonly token: string;
  readonly fetchJson?: ControlPlaneFetch;
  readonly fetchImpl?: typeof fetch;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function describeCloudError(cause: unknown): string {
  const status = controlPlaneErrorStatus(cause);
  if (status === 401)
    return "The Uno console didn't accept this computer's key. Reconnect it in Settings.";
  if (status === 403) return "This computer's key isn't allowed to use Cloud storage.";
  if (status === 402) return "Cloud storage is full. Free up space or upgrade your plan.";
  if (status === 404) return "This bucket or file doesn't exist anymore.";
  if (status === 409) return "A bucket with that name already exists.";
  if (status === 503) return "Cloud storage isn't available right now.";
  if (status !== null) return `Cloud storage answered ${status}.`;
  return "Couldn't reach Cloud storage. Check the internet connection.";
}

export class CloudError extends FilesPathError {
  constructor(message: string) {
    super("forbidden", message);
    this.name = "CloudError";
  }
}

async function call(deps: CloudDeps, path: string, init?: RequestInit): Promise<unknown> {
  try {
    return await (deps.fetchJson ?? fetchControlPlaneJson)(deps.token, path, init);
  } catch (cause) {
    throw new CloudError(describeCloudError(cause));
  }
}

export function parseBucket(raw: unknown): FilesCloudBucket | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number") return null;
  return { id, name: str(record["name"]), usedBytes: num(record["used_bytes"]) };
}

export function parseCloudState(raw: unknown): FilesCloudState {
  const record = (raw ?? {}) as Record<string, unknown>;
  const buckets = Array.isArray(record["buckets"])
    ? record["buckets"]
        .map(parseBucket)
        .filter((bucket): bucket is FilesCloudBucket => bucket !== null)
    : [];
  const storage = (record["storage"] ?? {}) as Record<string, unknown>;
  const usedBytes =
    storage["used_bytes"] !== undefined
      ? num(storage["used_bytes"])
      : buckets.reduce((sum, bucket) => sum + bucket.usedBytes, 0);
  return {
    available: true,
    message: null,
    usedBytes,
    backupsBytes: num(storage["backups_bytes"]),
    quotaBytes: num(storage["quota_bytes"]),
    overQuota: storage["over_quota"] === true,
    buckets: buckets.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function cloudState(deps: CloudDeps): Promise<FilesCloudState> {
  return parseCloudState(await call(deps, "/api/v1/buckets"));
}

async function findBucket(deps: CloudDeps, bucketId: number): Promise<FilesCloudBucket> {
  const state = await cloudState(deps);
  const bucket = state.buckets.find((candidate) => candidate.id === bucketId);
  if (!bucket) throw new CloudError("This bucket doesn't exist anymore.");
  return bucket;
}

/** "" or a relative folder path ending in "/", without traversal. */
export function normalizeCloudPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "");
  if (trimmed === "") return "";
  const withSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  if (
    withSlash
      .split("/")
      .some(
        (segment, index, all) =>
          (segment === "" && index < all.length - 1) || segment === "." || segment === "..",
      )
  ) {
    throw new CloudError("That folder name isn't valid.");
  }
  return withSlash;
}

function lastSegment(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function parseListing(raw: unknown, prefix: string) {
  const record = (raw ?? {}) as Record<string, unknown>;
  const folders = (Array.isArray(record["folders"]) ? record["folders"] : [])
    .map(str)
    .filter((folder) => folder.startsWith(prefix) && folder.endsWith("/"))
    .map((folder) => ({ prefix: folder, name: lastSegment(folder) }))
    // Older copies of Office documents; people reach them via Office → Versions.
    .filter((folder) => folder.name !== CLOUD_VERSIONS_FOLDER)
    // Git projects synced between computers (`uno project`): reached through git.
    .filter((folder) => !(prefix === "" && folder.name === DRIVE_GIT_ROOT));
  const objects = (Array.isArray(record["objects"]) ? record["objects"] : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const object = item as Record<string, unknown>;
    const key = str(object["key"]);
    if (!key || !key.startsWith(prefix)) return [];
    const modified = str(object["last_modified"]);
    return [
      {
        key,
        name: lastSegment(key),
        size: num(object["size"]),
        modifiedAt: modified && !modified.startsWith("0001-") ? modified : null,
      },
    ];
  });
  return { folders, objects, truncated: record["truncated"] === true };
}

export async function cloudList(
  deps: CloudDeps,
  input: { readonly bucketId: number; readonly prefix?: string | undefined },
): Promise<FilesCloudListResult> {
  const prefix = normalizeCloudPrefix(input.prefix);
  const bucket = await findBucket(deps, input.bucketId);
  const listing = await listObjects(deps, bucket.id, prefix);
  return listing
    ? { bucket, prefix, ...listing, listingSupported: true }
    : { bucket, prefix, folders: [], objects: [], truncated: false, listingSupported: false };
}

/** One folder of a bucket (prefix already normalized); null on a console that can't list. */
async function listObjects(
  deps: CloudDeps,
  bucketId: number,
  prefix: string,
): Promise<ReturnType<typeof parseListing> | null> {
  try {
    const raw = await (deps.fetchJson ?? fetchControlPlaneJson)(
      deps.token,
      `/api/v1/buckets/${bucketId}/objects?prefix=${encodeURIComponent(prefix)}`,
    );
    return parseListing(raw, prefix);
  } catch (cause) {
    // Consoles older than the objects route answer 404/405 for the path.
    const status = controlPlaneErrorStatus(cause);
    if (status === 404 || status === 405) return null;
    throw new CloudError(describeCloudError(cause));
  }
}

/** `a/b/c.txt` → `a/b/`, `a/b/` → `a/`, `c.txt` → "". */
function parentPrefix(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/**
 * The size of one object, from a ranged GET (for when a listing can't tell);
 * null when it doesn't exist or storage won't say.
 */
async function probeObjectSize(
  deps: CloudDeps,
  bucketId: number,
  key: string,
): Promise<number | null> {
  const url = await cloudPresign(deps, bucketId, key, "get");
  const response = await (deps.fetchImpl ?? fetch)(url, { headers: { range: "bytes=0-0" } }).catch(
    () => null,
  );
  if (!response) return null;
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) return null;
  const total = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1];
  const size = Number(total ?? response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/**
 * Which of `keys` exist in the bucket, with their sizes. Lists each folder
 * once and skips folders their parent says aren't there (a fresh folder
 * upload costs one listing); a key a listing can't vouch for (a console
 * without listing, a truncated folder) is probed on its own.
 */
export async function existingObjectSizes(
  deps: CloudDeps,
  bucketId: number,
  keys: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  const listings = new Map<string, Promise<ReturnType<typeof parseListing> | null>>();
  const list = (prefix: string) => {
    let listing = listings.get(prefix);
    if (!listing) {
      listing = listObjects(deps, bucketId, prefix);
      listings.set(prefix, listing);
    }
    return listing;
  };
  const folderMayExist = async (prefix: string): Promise<boolean> => {
    if (prefix === "") return true;
    const parent = parentPrefix(prefix);
    if (!(await folderMayExist(parent))) return false;
    const listing = await list(parent);
    if (listing === null || listing.truncated) return true;
    return listing.folders.some((folder) => folder.prefix === prefix);
  };
  const sizes = new Map<string, number>();
  for (const key of keys) {
    const folder = parentPrefix(key);
    if (!(await folderMayExist(folder))) continue;
    const listing = await list(folder);
    const listed = listing?.objects.find((object) => object.key === key);
    if (listed) {
      sizes.set(key, listed.size);
      continue;
    }
    if (listing !== null && !listing.truncated) continue;
    const probed = await probeObjectSize(deps, bucketId, key);
    if (probed !== null) sizes.set(key, probed);
  }
  return sizes;
}

/** Every object key under a folder prefix, walking sub-folders. */
async function listRecursive(
  deps: CloudDeps,
  bucketId: number,
  prefix: string,
): Promise<Array<{ key: string; size: number }>> {
  const out: Array<{ key: string; size: number }> = [];
  const queue = [prefix];
  while (queue.length > 0 && out.length <= TRANSFER_MAX_FILES) {
    const listing = await cloudList(deps, { bucketId, prefix: queue.shift()! });
    if (!listing.listingSupported) {
      throw new CloudError(
        "This console can't list folders yet, so a whole folder can't be copied.",
      );
    }
    out.push(...listing.objects.map((object) => ({ key: object.key, size: object.size })));
    queue.push(...listing.folders.map((folder) => folder.prefix));
  }
  return out;
}

export async function cloudCreateBucket(deps: CloudDeps, name: string): Promise<FilesCloudBucket> {
  const raw = await call(deps, "/api/v1/buckets", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const bucket = parseBucket(raw);
  if (!bucket) throw new CloudError("The console didn't return the new bucket.");
  return bucket;
}

async function deleteObjects(deps: CloudDeps, bucketId: number, key: string): Promise<number> {
  const raw = await call(
    deps,
    `/api/v1/buckets/${bucketId}/objects?key=${encodeURIComponent(key)}`,
    {
      method: "DELETE",
    },
  );
  return num((raw as Record<string, unknown> | null)?.["deleted"]);
}

/**
 * Delete one object, or a whole folder (a key ending in "/": the console
 * deletes everything under it, `.versions/` folders included). A file's
 * older copies go with it (best effort, once the file itself is gone).
 * Returns how many objects the console deleted for `key`.
 */
export async function cloudDelete(deps: CloudDeps, bucketId: number, key: string): Promise<number> {
  const deleted = await deleteObjects(deps, bucketId, key);
  if (!key.endsWith("/") && !isCloudVersionKey(key)) {
    await deleteObjects(deps, bucketId, cloudVersionsPrefix(key)).catch(() => 0);
  }
  return deleted;
}

/** A presigned download link. Uploads go through `cloudUpload` (any size). */
export async function cloudPresign(
  deps: CloudDeps,
  bucketId: number,
  key: string,
  method: "get",
): Promise<string> {
  const raw = await call(deps, `/api/v1/buckets/${bucketId}/presign`, {
    method: "POST",
    body: JSON.stringify({ key, method, ttl: PRESIGN_TTL_SECONDS }),
  });
  const url = str((raw as Record<string, unknown> | null)?.["url"]);
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new CloudError("The console didn't return an upload address.");
  }
  return url;
}

/**
 * Upload one object of any size: one PUT or parts, as the console says
 * (cloudUpload.ts). Console errors read like the rest of Cloud storage;
 * storage errors name the file, or say what `storageMessage` says.
 */
export async function cloudUpload(
  deps: CloudDeps,
  bucketId: number,
  key: string,
  source: UploadSource,
  options: {
    readonly contentType?: string | undefined;
    readonly onProgress?: ((uploadedBytes: number, totalBytes: number) => void) | undefined;
    readonly storageMessage?: ((error: CloudUploadError) => string) | undefined;
    /** Parts in flight (each held in memory when the source is a stream). */
    readonly concurrency?: number | undefined;
  } = {},
): Promise<void> {
  try {
    await uploadToBucket({
      presign: (body) =>
        (deps.fetchJson ?? fetchControlPlaneJson)(
          deps.token,
          `/api/v1/buckets/${bucketId}/presign`,
          { method: "POST", body: JSON.stringify(body) },
        ),
      fetchImpl: deps.fetchImpl,
      key,
      source,
      contentType: options.contentType,
      onProgress: options.onProgress,
      concurrency: options.concurrency,
    });
  } catch (cause) {
    if (cause instanceof CloudUploadError) {
      if (cause.code === "bad_console_answer") {
        throw new CloudError("The console didn't return an upload address.");
      }
      throw new CloudError(
        options.storageMessage?.(cause) ??
          `Uploading “${lastSegment(key)}” failed (${cause.message}).`,
      );
    }
    throw new CloudError(describeCloudError(cause));
  }
}

/**
 * One step of an upload the browser sends straight to storage (bigger files,
 * which a small computer's disk couldn't hold on the way). The console's
 * answer goes back as it came, its refusal as an answer too.
 *
 * Starting one keeps what it replaces, as {@link copyToCloud} does: only a
 * *replaced* file over the limit goes without an older copy, however big the
 * new one is. Asked after the console agrees, so a file over the plan's quota
 * doesn't cost an older copy first. Never a reason not to upload.
 */
export async function cloudUploadStep(
  deps: CloudDeps,
  input: FilesCloudUploadStepInput,
): Promise<FilesCloudUploadStepResult> {
  const { bucketId, ...body } = input;
  let answer: unknown;
  try {
    answer = await (deps.fetchJson ?? fetchControlPlaneJson)(
      deps.token,
      `/api/v1/buckets/${bucketId}/presign`,
      { method: "POST", body: JSON.stringify(body) },
    );
  } catch (cause) {
    return {
      refusal: {
        status: controlPlaneErrorStatus(cause),
        message: describeCloudError(cause),
        detail: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
  if (input.method === "put" && input.upload_id === undefined) {
    const existing = await existingObjectSizes(deps, bucketId, [input.key]).catch(
      () => new Map<string, number>(),
    );
    const size = existing.get(input.key);
    if (size !== undefined && cloudVersionSkipReason(input.key, size, 0) === null) {
      // Never a reason not to save, as in `copyToCloud`.
      const outcome = await keepCloudVersion(deps, {
        bucketId,
        key: input.key,
        now: new Date(),
      }).catch(() => null);
      if (outcome?.kind === "kept") {
        await pruneCloudVersions(deps, bucketId, input.key).catch(() => undefined);
      }
    }
  }
  return { answer };
}

// ── Older copies ───────────────────────────────────────────────────────────

/** A plain MD5 ETag (single-part upload), lowercased without quotes; null otherwise. */
export function plainMd5Etag(etag: string | null): string | null {
  const match = /^(?:W\/)?"?([0-9a-f]{32})"?$/i.exec(etag?.trim() ?? "");
  return match ? match[1]!.toLowerCase() : null;
}

/** MD5 of a file on disk, streamed. */
async function fileMd5(path: string): Promise<string> {
  const hash = createHash("md5");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export type KeepVersionOutcome =
  | { readonly kind: "kept" }
  /** The object is gone: nothing is being replaced. */
  | { readonly kind: "gone" }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * Copy the current object `key` to its versions folder (cloudVersions.ts),
 * streamed from storage back into storage — nothing touches the disk, one
 * part in memory at a time. Never throws: a copy that can't be made says why
 * (`skipped`), and the caller replaces the file anyway. When `replacement`
 * has the same bytes (same size, and a plain-MD5 ETag equal to its MD5)
 * there is nothing worth keeping.
 */
export async function keepCloudVersion(
  deps: CloudDeps,
  input: {
    readonly bucketId: number;
    readonly key: string;
    readonly now: Date;
    /** The file about to replace it, to skip copies of unchanged content. */
    readonly replacement?: { readonly path: string; readonly size: number } | undefined;
  },
): Promise<KeepVersionOutcome> {
  let body: ReadableStream | null = null;
  let reader: Readable | null = null;
  // Stop the download: the upload of it failed, or it isn't needed.
  const drop = async () => {
    if (reader) reader.destroy();
    else await body?.cancel().catch(() => undefined);
  };
  try {
    const url = await cloudPresign(deps, input.bucketId, input.key, "get");
    // Stored bytes as they are: a decoded body wouldn't match its length.
    const response = await (deps.fetchImpl ?? fetch)(url, {
      headers: { "accept-encoding": "identity" },
    });
    body = response.body;
    if (response.status === 404) {
      await drop();
      return { kind: "gone" };
    }
    if (!response.ok || !body) {
      await drop();
      return { kind: "skipped", reason: `couldn't read it (storage answered ${response.status})` };
    }
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    const size = Number(response.headers.get("content-length") ?? Number.NaN);
    if ((encoding && encoding !== "identity") || !Number.isSafeInteger(size) || size < 0) {
      await drop();
      return { kind: "skipped", reason: "storage didn't say its exact size" };
    }
    const etag = plainMd5Etag(response.headers.get("etag"));
    if (
      input.replacement &&
      etag !== null &&
      input.replacement.size === size &&
      (await fileMd5(input.replacement.path).catch(() => null)) === etag
    ) {
      await drop();
      return { kind: "skipped", reason: "unchanged" };
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    reader = Readable.fromWeb(body as never);
    await cloudUpload(
      deps,
      input.bucketId,
      cloudVersionKey(input.key, input.now),
      streamUploadSource(reader, size),
      {
        contentType,
        concurrency: 1,
        storageMessage: (error) =>
          error.status === 402 || error.status === 403
            ? "no room in cloud storage for the older copy"
            : `couldn't keep the older copy (${error.message})`,
      },
    );
    return { kind: "kept" };
  } catch (cause) {
    await drop();
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "skipped",
      reason: /^(no room|couldn't keep)/.test(message)
        ? message
        : /Cloud storage is full/.test(message)
          ? "no room in cloud storage for the older copy"
          : `couldn't keep the older copy (${message})`,
    };
  }
}

/** Drops all but the newest kept copies of `key` (cloudVersions.ts). */
export async function pruneCloudVersions(
  deps: CloudDeps,
  bucketId: number,
  key: string,
): Promise<void> {
  const listing = await listObjects(deps, bucketId, cloudVersionsPrefix(key));
  if (!listing) return;
  for (const stale of staleCloudVersions(listing.objects.map((object) => object.key))) {
    await deleteObjects(deps, bucketId, stale);
  }
}

// ── Transfers ──────────────────────────────────────────────────────────────

interface LocalFile {
  readonly absolutePath: string;
  readonly relativeKey: string;
  readonly size: number;
}

async function collectLocal(
  path: string,
  baseName: string,
  out: LocalFile[],
  skipped: Array<{ name: string; reason: string }>,
): Promise<void> {
  const stats = await fsPromises.lstat(path);
  if (stats.isSymbolicLink()) {
    skipped.push({ name: baseName, reason: "shortcut (symlink)" });
    return;
  }
  if (stats.isFile()) {
    out.push({ absolutePath: path, relativeKey: baseName, size: stats.size });
    return;
  }
  if (!stats.isDirectory()) return;
  for (const dirent of await fsPromises.readdir(path, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue; // .env, .git never leave the computer
    if (out.length >= TRANSFER_MAX_FILES) {
      throw new CloudError(`That's more than ${TRANSFER_MAX_FILES} files. Copy a smaller folder.`);
    }
    await collectLocal(
      nodePath.join(path, dirent.name),
      `${baseName}/${dirent.name}`,
      out,
      skipped,
    );
  }
}

/** A file that replaced one already in the cloud, and whether the old one was kept. */
export interface CloudOverwrite {
  readonly key: string;
  readonly versionKept: boolean;
  readonly reason?: string;
}

/**
 * Upload files/folders (already resolved inside the home) into a bucket
 * folder. A file that replaces one already there keeps the old one as an
 * older copy (see {@link keepCloudVersion}, limits in cloudVersions.ts);
 * if that copy can't be made the file is replaced anyway and `overwritten`
 * says why no copy was kept.
 */
export async function copyToCloud(
  deps: CloudDeps,
  input: {
    readonly paths: ReadonlyArray<string>;
    readonly bucketId: number;
    readonly prefix?: string | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<
  FilesCloudTransferResult & {
    readonly uploadedPaths: ReadonlyArray<string>;
    readonly overwritten: ReadonlyArray<CloudOverwrite>;
  }
> {
  const prefix = normalizeCloudPrefix(input.prefix);
  const now = input.now ?? (() => new Date());
  const skipped: Array<{ name: string; reason: string }> = [];
  const files: LocalFile[] = [];
  for (const path of input.paths) await collectLocal(path, nodePath.basename(path), files, skipped);
  // Which files replace one already there; a console that can't tell only
  // costs those files their older copies.
  const existing =
    files.length > 0
      ? await existingObjectSizes(
          deps,
          input.bucketId,
          files.map((file) => `${prefix}${file.relativeKey}`),
        ).catch(() => new Map<string, number>())
      : new Map<string, number>();
  let bytes = 0;
  let versionsKept = 0;
  const uploadedPaths: string[] = [];
  const overwritten: CloudOverwrite[] = [];
  for (const file of files) {
    const key = `${prefix}${file.relativeKey}`;
    const existingSize = existing.get(key);
    let versionKept = false;
    if (existingSize !== undefined) {
      const skip = cloudVersionSkipReason(key, existingSize, versionsKept);
      const outcome: KeepVersionOutcome =
        skip === null
          ? await keepCloudVersion(deps, {
              bucketId: input.bucketId,
              key,
              now: now(),
              replacement: { path: file.absolutePath, size: file.size },
            })
          : { kind: "skipped", reason: skip };
      if (outcome.kind === "kept") {
        versionKept = true;
        versionsKept += 1;
        overwritten.push({ key, versionKept: true });
      } else if (outcome.kind === "skipped") {
        // Never a reason not to save: the file is replaced, the reply says so.
        overwritten.push({ key, versionKept: false, reason: outcome.reason });
      }
    }
    // Any size: the console answers big files with parts (cloudUpload.ts) and
    // refuses with 402 what doesn't fit the plan.
    await cloudUpload(deps, input.bucketId, key, fileUploadSource(file.absolutePath, file.size), {
      storageMessage: (error) => `Uploading “${file.relativeKey}” failed (${error.message}).`,
    });
    if (versionKept) {
      // Best effort: an extra old copy is better than a failed save.
      await pruneCloudVersions(deps, input.bucketId, key).catch(() => undefined);
    }
    bytes += file.size;
    uploadedPaths.push(file.absolutePath);
  }
  return { files: uploadedPaths.length, bytes, skipped, uploadedPaths, overwritten };
}

/**
 * Download objects (or whole folders, keys ending in "/") into a folder on
 * the computer. Everything is listed first: a copy that would leave the disk
 * almost full is refused before the first byte (diskSpace.ts).
 */
export async function copyToComputer(
  deps: CloudDeps,
  input: {
    readonly bucketId: number;
    readonly keys: ReadonlyArray<string>;
    readonly destinationDir: string;
    /** Tests: the destination volume's space. */
    readonly measureDisk?: Parameters<typeof ensureDiskSpace>[2];
  },
): Promise<FilesCloudTransferResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const skipped: Array<{ name: string; reason: string }> = [];
  const landed: string[] = [];
  const singleKeys = input.keys.filter((key) => !key.endsWith("/"));
  // Sizes are for the space check only: one the console can't tell counts as 0.
  const singleSizes =
    singleKeys.length > 0
      ? await existingObjectSizes(deps, input.bucketId, singleKeys).catch(
          () => new Map<string, number>(),
        )
      : new Map<string, number>();
  const plans: Array<{
    readonly key: string;
    readonly isFolder: boolean;
    readonly objects: ReadonlyArray<{ key: string; size: number }>;
  }> = [];
  for (const key of input.keys) {
    const isFolder = key.endsWith("/");
    plans.push({
      key,
      isFolder,
      objects: isFolder
        ? await listRecursive(deps, input.bucketId, normalizeCloudPrefix(key))
        : [{ key, size: singleSizes.get(key) ?? 0 }],
    });
  }
  const needBytes = plans.reduce(
    (sum, plan) => sum + plan.objects.reduce((part, object) => part + object.size, 0),
    0,
  );
  await ensureDiskSpace(input.destinationDir, needBytes, input.measureDisk);
  let files = 0;
  let bytes = 0;
  for (const { key, isFolder, objects } of plans) {
    const filesBefore = files;
    // A folder lands as a new folder next to what's there (keep both).
    const root = isFolder
      ? await uniqueDestination(input.destinationDir, lastSegment(key))
      : input.destinationDir;
    const folderBase = isFolder ? normalizeCloudPrefix(key) : "";
    for (const object of objects) {
      const relative = isFolder ? object.key.slice(folderBase.length) : lastSegment(object.key);
      const segments = relative.split("/").filter(Boolean);
      if (
        segments.length === 0 ||
        segments.some((segment) => segment === ".." || segment === ".")
      ) {
        skipped.push({ name: object.key, reason: "unsafe name" });
        continue;
      }
      const targetDir = nodePath.join(root, ...segments.slice(0, -1));
      await fsPromises.mkdir(targetDir, { recursive: true });
      const target = await uniqueDestination(targetDir, segments.at(-1)!);
      const url = await cloudPresign(deps, input.bucketId, object.key, "get");
      const response = await fetchImpl(url);
      if (!response.ok || !response.body) {
        throw new CloudError(
          `Downloading “${relative}” failed (storage answered ${response.status}).`,
        );
      }
      const staged = nodePath.join(
        targetDir,
        `.${nodePath.basename(target)}.uno-cloud-${process.pid}`,
      );
      try {
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(staged));
        await fsPromises.rename(staged, target);
      } catch (cause) {
        await fsPromises.rm(staged, { force: true });
        throw cause;
      }
      files += 1;
      bytes += (await fsPromises.stat(target)).size;
      if (!isFolder) landed.push(target);
    }
    if (isFolder && files > filesBefore) landed.push(root);
  }
  return { files, bytes, skipped, paths: landed };
}

export { ControlPlaneHttpError };
