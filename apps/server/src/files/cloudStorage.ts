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
} from "@t3tools/contracts";

import {
  ControlPlaneHttpError,
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";
import { FilesPathError, uniqueDestination } from "./filesPaths.ts";

/** Where Office keeps older copies of a Cloud document (see cloudOffice.ts). */
export const CLOUD_VERSIONS_FOLDER = ".versions";

/** Hostkey S3 drops single PUTs of a few hundred MB; stay under that. */
export const CLOUD_SINGLE_PUT_MAX_BYTES = 256 * 1024 * 1024;
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
    .filter((folder) => folder.name !== CLOUD_VERSIONS_FOLDER);
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
  try {
    const raw = await (deps.fetchJson ?? fetchControlPlaneJson)(
      deps.token,
      `/api/v1/buckets/${bucket.id}/objects?prefix=${encodeURIComponent(prefix)}`,
    );
    return { bucket, prefix, ...parseListing(raw, prefix), listingSupported: true };
  } catch (cause) {
    // Consoles older than the objects route answer 404/405 for the path.
    const status = controlPlaneErrorStatus(cause);
    if (status === 404 || status === 405) {
      return {
        bucket,
        prefix,
        folders: [],
        objects: [],
        truncated: false,
        listingSupported: false,
      };
    }
    throw new CloudError(describeCloudError(cause));
  }
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

export async function cloudDelete(deps: CloudDeps, bucketId: number, key: string): Promise<number> {
  const raw = await call(
    deps,
    `/api/v1/buckets/${bucketId}/objects?key=${encodeURIComponent(key)}`,
    {
      method: "DELETE",
    },
  );
  return num((raw as Record<string, unknown> | null)?.["deleted"]);
}

export async function cloudPresign(
  deps: CloudDeps,
  bucketId: number,
  key: string,
  method: "get" | "put",
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

/** Upload files/folders (already resolved inside the home) into a bucket folder. */
export async function copyToCloud(
  deps: CloudDeps,
  input: {
    readonly paths: ReadonlyArray<string>;
    readonly bucketId: number;
    readonly prefix?: string | undefined;
  },
): Promise<FilesCloudTransferResult & { readonly uploadedPaths: ReadonlyArray<string> }> {
  const prefix = normalizeCloudPrefix(input.prefix);
  const skipped: Array<{ name: string; reason: string }> = [];
  const files: LocalFile[] = [];
  for (const path of input.paths) await collectLocal(path, nodePath.basename(path), files, skipped);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let bytes = 0;
  const uploadedPaths: string[] = [];
  for (const file of files) {
    if (file.size > CLOUD_SINGLE_PUT_MAX_BYTES) {
      skipped.push({ name: file.relativeKey, reason: "bigger than 256 MB" });
      continue;
    }
    const url = await cloudPresign(deps, input.bucketId, `${prefix}${file.relativeKey}`, "put");
    const body =
      file.size === 0
        ? new Uint8Array()
        : (Readable.toWeb(createReadStream(file.absolutePath)) as unknown as ReadableStream);
    const response = await fetchImpl(url, {
      method: "PUT",
      body,
      headers: { "content-length": String(file.size) },
      ...(file.size === 0 ? {} : { duplex: "half" }),
    } as RequestInit);
    if (!response.ok) {
      throw new CloudError(
        `Uploading “${file.relativeKey}” failed (storage answered ${response.status}).`,
      );
    }
    bytes += file.size;
    uploadedPaths.push(file.absolutePath);
  }
  return { files: uploadedPaths.length, bytes, skipped, uploadedPaths };
}

/** Download objects (or whole folders, keys ending in "/") into a folder on the computer. */
export async function copyToComputer(
  deps: CloudDeps,
  input: {
    readonly bucketId: number;
    readonly keys: ReadonlyArray<string>;
    readonly destinationDir: string;
  },
): Promise<FilesCloudTransferResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const skipped: Array<{ name: string; reason: string }> = [];
  let files = 0;
  let bytes = 0;
  for (const key of input.keys) {
    const isFolder = key.endsWith("/");
    const objects = isFolder
      ? await listRecursive(deps, input.bucketId, normalizeCloudPrefix(key))
      : [{ key, size: 0 }];
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
    }
  }
  return { files, bytes, skipped };
}

export { ControlPlaneHttpError };
