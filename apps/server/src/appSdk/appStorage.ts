/**
 * App cloud storage — an app's own folder in the Uno account's cloud
 * (docs/app-sdk.md §"Cloud storage").
 *
 * The working disk of a computer is small and paid for by the gigabyte; the
 * account's cloud (S3) is cheap and roomy. Files a person keeps — photos,
 * documents, uploads, exports, archives — belong in the cloud, so an app that
 * asks for `"storage"` in its manifest gets a folder there:
 *
 *   Cloud → bucket `apps` → `<appId>/…`                 (shared, the default)
 *   Cloud → bucket `apps` → `<appId>@computer-<box>/…`   ("Only this computer")
 *
 * By default an app's folder is shared by every computer of the account that
 * has the same app. The person can switch an app to a folder of its own on
 * this computer (Settings → Apps). The two folders are siblings, not nested:
 * `notes/` never lists, counts or deletes `notes@computer-7/`, and the other
 * way round (an app id can't contain "@", see appManifest.ts). Switching
 * moves nothing: the app simply sees the other folder from then on.
 *
 * The app never sees an S3 key, the machine's console token or another app's
 * folder. It talks to the local App API with its own `uno_app_` token; the
 * daemon checks the key, prefixes it with the app's folder, checks the app's
 * limit, asks the console for a presigned URL with the machine's token and
 * streams the bytes. The console itself enforces the account's plan quota
 * (402) and keeps every key inside the account's prefix.
 *
 * @module appSdk/appStorage
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import {
  CLOUD_SINGLE_PUT_MAX_BYTES,
  type CloudDeps,
  parseBucket,
  parseCloudState,
  parseListing,
} from "../files/cloudStorage.ts";
import {
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";

/** The bucket every app's folder lives in (created on first use). */
export const APP_STORAGE_BUCKET = "apps";
export const GB = 1024 * 1024 * 1024;
/** Presigned download links live at most an hour (the console clamps too). */
export const APP_STORAGE_URL_MAX_SECONDS = 3600;
const APP_STORAGE_URL_DEFAULT_SECONDS = 900;
/** How long a measured folder size is trusted before it is walked again. */
const USAGE_TTL_MS = 5 * 60_000;
/** Folders walked when measuring one app (a guard, not a product limit). */
const USAGE_MAX_FOLDERS = 500;
const KEY_MAX_LENGTH = 512;

export interface AppStorageReply {
  readonly status: number;
  readonly body: unknown;
}

const err = (status: number, code: string, message: string): AppStorageReply => ({
  status,
  body: { error: { type: code, code, message } },
});

export const STORAGE_NOT_CONNECTED_MESSAGE =
  "This computer isn't connected to an Uno account, so it has no cloud storage. Sign in to Uno in Uno Work.";
export const APP_STORAGE_FULL_MESSAGE =
  "This app filled its cloud storage limit. The person who owns this computer can raise it in Uno Work → Settings → Apps.";
export const CLOUD_FULL_MESSAGE =
  "The Uno account's cloud storage is full. Free up space in Files → Cloud storage or upgrade the plan.";

/**
 * A file key relative to the app's folder: `photos/2026/cat.jpg`. Folders
 * (for list / delete) end in "/". No leading slash, no empty, "." or ".."
 * segments, no control characters or backslashes.
 */
export function validateStorageKey(
  raw: unknown,
  kind: "file" | "folder" | "file-or-folder",
): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.normalize("NFC");
  if (key === "" || key.length > KEY_MAX_LENGTH) return null;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return null;
  if (key.startsWith("/")) return null;
  const isFolder = key.endsWith("/");
  if (kind === "file" && isFolder) return null;
  if (kind === "folder" && !isFolder) return null;
  const segments = (isFolder ? key.slice(0, -1) : key).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return key;
}

/** "" (the app's whole folder) or a folder key ending in "/". */
export function validateStoragePrefix(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
  return validateStorageKey(withSlash, "folder");
}

/** Where an app keeps its files: shared by the account's computers, or this computer only. */
export type AppStorageScope = "account" | "computer";

/**
 * The app's folder in the `apps` bucket. `computerKey` (from
 * `appStorageComputerKey`) is given for the "Only this computer" folder.
 */
export function appFolder(appId: string, computerKey: string | null = null): string {
  return computerKey ? `${appId}@${computerKey}/` : `${appId}/`;
}

/**
 * Names this computer inside folder names: `computer-<box id>` on an Uno
 * computer (a copy made from its image is another box, so another folder),
 * otherwise `local-<random id kept in the daemon's state>`.
 */
export function appStorageComputerKey(boxId: number | null | undefined, localId: string): string {
  return typeof boxId === "number" && Number.isInteger(boxId) && boxId > 0
    ? `computer-${boxId}`
    : `local-${localId}`;
}

export interface AppStorageUsage {
  readonly usedBytes: number;
  readonly files: number;
  readonly measuredAt: string;
  readonly partial: boolean;
}

export interface AppStorageDeps {
  /** The machine's console token (work-machine token), "" when not linked. */
  readonly token: () => Promise<string>;
  readonly fetchJson?: CloudDeps["fetchJson"];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** A failed `deleteFolder`, with a message a person can read. */
export class AppStorageError extends Error {}

class StorageFailure extends Error {
  readonly reply: AppStorageReply;
  constructor(reply: AppStorageReply) {
    super("storage failure");
    this.reply = reply;
  }
}

function fromConsoleError(cause: unknown): AppStorageReply {
  const status = controlPlaneErrorStatus(cause);
  if (status === 402) return err(402, "cloud_full", CLOUD_FULL_MESSAGE);
  if (status === 401)
    return err(
      503,
      "storage_not_connected",
      "The Uno console didn't accept this computer's key. Reconnect the computer in Uno Work → Settings.",
    );
  if (status === 403)
    return err(
      503,
      "storage_not_allowed",
      "This computer's key isn't allowed to use cloud storage yet. Reconnect it in Uno Work → Settings.",
    );
  if (status === 503)
    return err(503, "storage_unavailable", "Cloud storage isn't available right now.");
  if (status === 404) return err(404, "file_not_found", "No such file in this app's cloud folder.");
  const message = cause instanceof Error ? cause.message : String(cause);
  return err(502, "storage_unreachable", `Cloud storage didn't answer: ${message.slice(0, 200)}`);
}

export interface AppStorage {
  /** Size of one app folder (`appFolder(...)`), walked at most every few minutes. */
  readonly usage: (folder: string, options?: { fresh?: boolean }) => Promise<AppStorageUsage>;
  /** Last measured usage without touching the network (null = not measured yet). */
  readonly cachedUsage: (folder: string) => AppStorageUsage | null;
  /**
   * Deletes everything in one app folder (the person asked, when removing the
   * app). Resolves to the number of files deleted; throws `AppStorageError`.
   */
  readonly deleteFolder: (folder: string) => Promise<number>;
  readonly bucketId: () => Promise<number | null>;
  readonly handle: (
    input: {
      /** The caller's folder, e.g. `album/` — every key lands inside it. */
      readonly folder: string;
      readonly limitBytes: number;
      readonly method: string;
      readonly route: string;
      readonly url: URL;
    },
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<AppStorageReply | null>;
}

/** A small JSON body (64 KB max); null when it isn't JSON. */
const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });

export function makeAppStorage(deps: AppStorageDeps): AppStorage {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const usageCache = new Map<string, AppStorageUsage & { at: number; stale: boolean }>();
  let bucket: { token: string; id: number } | null = null;

  const cloudDeps = async (): Promise<CloudDeps> => {
    const token = (await deps.token()).trim();
    if (!token) {
      throw new StorageFailure(err(503, "storage_not_connected", STORAGE_NOT_CONNECTED_MESSAGE));
    }
    return {
      token,
      ...(deps.fetchJson ? { fetchJson: deps.fetchJson } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
  };

  /** One console call with the machine's token; failures keep their HTTP status. */
  const consoleJson = async (
    cd: CloudDeps,
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await (cd.fetchJson ?? fetchControlPlaneJson)(cd.token, path, init);
      return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    } catch (cause) {
      throw new StorageFailure(fromConsoleError(cause));
    }
  };

  const ensureBucket = async (cd: CloudDeps): Promise<number> => {
    if (bucket && bucket.token === cd.token) return bucket.id;
    const find = async () =>
      parseCloudState(await consoleJson(cd, "/api/v1/buckets")).buckets.find(
        (candidate) => candidate.name === APP_STORAGE_BUCKET,
      ) ?? null;
    let found = await find();
    if (!found) {
      try {
        found = parseBucket(
          await consoleJson(cd, "/api/v1/buckets", {
            method: "POST",
            body: JSON.stringify({ name: APP_STORAGE_BUCKET }),
          }),
        );
      } catch {
        // Two apps raced to create it (409): look again.
        found = await find();
      }
    }
    if (!found) {
      throw new StorageFailure(
        err(503, "storage_unavailable", "Couldn't open the apps folder in cloud storage."),
      );
    }
    bucket = { token: cd.token, id: found.id };
    return found.id;
  };

  const presign = async (
    cd: CloudDeps,
    bucketId: number,
    key: string,
    method: "get" | "put",
    ttlSeconds = APP_STORAGE_URL_MAX_SECONDS,
  ): Promise<string> => {
    try {
      const raw = await consoleJson(cd, `/api/v1/buckets/${bucketId}/presign`, {
        method: "POST",
        body: JSON.stringify({ key, method, ttl: ttlSeconds }),
      });
      const url = typeof raw?.["url"] === "string" ? raw["url"] : "";
      if (!/^https?:\/\//.test(url)) {
        throw new StorageFailure(
          err(502, "storage_unreachable", "The Uno console returned no storage address."),
        );
      }
      return url;
    } catch (cause) {
      // The bucket was deleted in Files: find or create it again next time.
      if (cause instanceof StorageFailure && cause.reply.status === 404) bucket = null;
      throw cause;
    }
  };

  /** One folder level of the bucket, keys relative to the bucket. */
  const listLevel = async (cd: CloudDeps, bucketId: number, prefix: string) => {
    try {
      const raw = await (cd.fetchJson ?? fetchControlPlaneJson)(
        cd.token,
        `/api/v1/buckets/${bucketId}/objects?prefix=${encodeURIComponent(prefix)}`,
      );
      return { ...parseListing(raw, prefix), listingSupported: true };
    } catch (cause) {
      const status = controlPlaneErrorStatus(cause);
      // Consoles older than the objects route answer 405 for the path.
      if (status === 405) {
        return { folders: [], objects: [], truncated: false, listingSupported: false };
      }
      if (status === 404) bucket = null;
      throw new StorageFailure(fromConsoleError(cause));
    }
  };

  const measure = async (folder: string): Promise<AppStorageUsage> => {
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    let usedBytes = 0;
    let files = 0;
    let folders = 0;
    const queue = [folder];
    while (queue.length > 0 && folders < USAGE_MAX_FOLDERS) {
      folders += 1;
      const listing = await listLevel(cd, bucketId, queue.shift()!);
      if (!listing.listingSupported) break;
      for (const object of listing.objects) {
        usedBytes += object.size;
        files += 1;
      }
      queue.push(...listing.folders.map((folder) => folder.prefix));
    }
    const usage = {
      usedBytes,
      files,
      measuredAt: new Date(now()).toISOString(),
      partial: queue.length > 0,
    };
    usageCache.set(folder, { ...usage, at: now(), stale: false });
    return usage;
  };

  const usage: AppStorage["usage"] = async (folder, options = {}) => {
    const cached = usageCache.get(folder);
    if (!options.fresh && cached && !cached.stale && now() - cached.at < USAGE_TTL_MS) {
      return cached;
    }
    return measure(folder);
  };

  const adjustUsage = (folder: string, deltaBytes: number, deltaFiles: number) => {
    const cached = usageCache.get(folder);
    if (!cached) return;
    usageCache.set(folder, {
      ...cached,
      usedBytes: Math.max(0, cached.usedBytes + deltaBytes),
      files: Math.max(0, cached.files + deltaFiles),
      // An overwrite counts twice until the next walk; walk again soon.
      stale: true,
    });
  };

  // ── routes ───────────────────────────────────────────────────────────────

  const info = async (folder: string, limitBytes: number): Promise<AppStorageReply> => {
    const measured = await usage(folder);
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    return {
      status: 200,
      body: {
        folder: `Cloud storage → ${APP_STORAGE_BUCKET}/${folder}`,
        bucketId,
        usedBytes: measured.usedBytes,
        files: measured.files,
        limitBytes,
        remainingBytes: Math.max(0, limitBytes - measured.usedBytes),
      },
    };
  };

  const list = async (folder: string, url: URL): Promise<AppStorageReply> => {
    const prefix = validateStoragePrefix(url.searchParams.get("prefix"));
    if (prefix === null) {
      return err(400, "invalid_key", 'The folder must look like "photos/2026/".');
    }
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    const base = folder;
    const listing = await listLevel(cd, bucketId, base + prefix);
    if (!listing.listingSupported) {
      return err(501, "listing_not_supported", "This Uno console can't list cloud folders yet.");
    }
    return {
      status: 200,
      body: {
        prefix,
        folders: listing.folders.map((folder) => folder.prefix.slice(base.length)),
        files: listing.objects.map((object) => ({
          key: object.key.slice(base.length),
          name: object.name,
          size: object.size,
          modifiedAt: object.modifiedAt,
        })),
        truncated: listing.truncated,
      },
    };
  };

  const put = async (
    folder: string,
    limitBytes: number,
    key: string,
    req: IncomingMessage,
  ): Promise<AppStorageReply> => {
    const lengthHeader = req.headers["content-length"];
    const size = typeof lengthHeader === "string" ? Number(lengthHeader) : Number.NaN;
    if (!Number.isInteger(size) || size < 0) {
      return err(
        411,
        "length_required",
        "Send the file with a Content-Length header (the SDKs do this for you).",
      );
    }
    if (size > CLOUD_SINGLE_PUT_MAX_BYTES) {
      return err(
        413,
        "file_too_large",
        `One file can be at most ${CLOUD_SINGLE_PUT_MAX_BYTES / 1024 / 1024} MB for now.`,
      );
    }
    const measured = await usage(folder);
    if (measured.usedBytes + size > limitBytes) {
      return err(507, "app_storage_full", APP_STORAGE_FULL_MESSAGE);
    }
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    const url = await presign(cd, bucketId, folder + key, "put");
    const contentType = req.headers["content-type"];
    const headers: Record<string, string> = { "content-length": String(size) };
    if (typeof contentType === "string" && contentType.length < 200) {
      headers["content-type"] = contentType;
    }
    const upstream = await fetchImpl(url, {
      method: "PUT",
      headers,
      body: size === 0 ? new Uint8Array() : (Readable.toWeb(req) as unknown as ReadableStream),
      ...(size === 0 ? {} : { duplex: "half" }),
    } as RequestInit).catch(() => null);
    if (!upstream) {
      return err(502, "storage_unreachable", "Couldn't reach cloud storage to upload the file.");
    }
    await upstream.body?.cancel().catch(() => undefined);
    if (!upstream.ok) {
      return err(
        502,
        "upload_failed",
        `Cloud storage refused the file (answered ${upstream.status}).`,
      );
    }
    adjustUsage(folder, size, 1);
    return { status: 201, body: { key, size } };
  };

  const get = async (folder: string, key: string, req: IncomingMessage, res: ServerResponse) => {
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    const url = await presign(cd, bucketId, folder + key, "get");
    const headers: Record<string, string> = {};
    const range = req.headers["range"];
    if (typeof range === "string") headers["range"] = range;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const upstream = await fetchImpl(url, { headers, signal: abort.signal }).catch(() => null);
    if (!upstream) {
      return err(502, "storage_unreachable", "Couldn't reach cloud storage to read the file.");
    }
    // S3 answers 403 for a missing key when listing isn't allowed on the URL.
    if (upstream.status === 404 || upstream.status === 403) {
      await upstream.body?.cancel().catch(() => undefined);
      return err(404, "file_not_found", "No such file in this app's cloud folder.");
    }
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      return err(502, "download_failed", `Cloud storage answered ${upstream.status}.`);
    }
    const out: Record<string, string> = { "cache-control": "no-store" };
    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    res.writeHead(upstream.status, out);
    if (req.method === "HEAD" || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      res.end();
      return null;
    }
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    } catch {
      // The app went away mid-download.
    }
    res.end();
    return null;
  };

  const remove = async (folder: string, key: string): Promise<AppStorageReply> => {
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    const raw = await consoleJson(
      cd,
      `/api/v1/buckets/${bucketId}/objects?key=${encodeURIComponent(folder + key)}`,
      { method: "DELETE" },
    );
    const deleted = typeof raw?.["deleted"] === "number" ? raw["deleted"] : 0;
    // Sizes of deleted files aren't known here: measure again next time.
    const cached = usageCache.get(folder);
    if (cached) usageCache.set(folder, { ...cached, stale: true });
    return { status: 200, body: { deleted } };
  };

  const link = async (folder: string, body: unknown): Promise<AppStorageReply> => {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const key = validateStorageKey(record["key"], "file");
    if (key === null)
      return err(400, "invalid_key", 'Give the file\'s "key", e.g. "photos/cat.jpg".');
    const requested = record["expiresIn"];
    const ttl =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(60, Math.min(APP_STORAGE_URL_MAX_SECONDS, Math.round(requested)))
        : APP_STORAGE_URL_DEFAULT_SECONDS;
    const cd = await cloudDeps();
    const bucketId = await ensureBucket(cd);
    const url = await presign(cd, bucketId, folder + key, "get", ttl);
    return {
      status: 200,
      body: { url, key, expiresAt: new Date(now() + ttl * 1000).toISOString() },
    };
  };

  const deleteFolder: AppStorage["deleteFolder"] = async (folder) => {
    if (validateStorageKey(folder, "folder") === null || folder.split("/").length !== 2) {
      throw new AppStorageError("That isn't an app folder.");
    }
    try {
      const cd = await cloudDeps();
      const bucketId = await ensureBucket(cd);
      const raw = await consoleJson(
        cd,
        `/api/v1/buckets/${bucketId}/objects?key=${encodeURIComponent(folder)}`,
        { method: "DELETE" },
      );
      usageCache.delete(folder);
      return typeof raw?.["deleted"] === "number" ? raw["deleted"] : 0;
    } catch (cause) {
      if (cause instanceof StorageFailure) {
        const body = cause.reply.body as { error?: { message?: string } };
        throw new AppStorageError(body.error?.message ?? "Cloud storage failed.");
      }
      throw new AppStorageError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handle: AppStorage["handle"] = async (
    { folder, limitBytes, method, route, url },
    req,
    res,
  ) => {
    try {
      if (route === "/v1/storage" && method === "GET") return await info(folder, limitBytes);
      if (route === "/v1/storage/list" && method === "GET") return await list(folder, url);
      if (route === "/v1/storage/url" && method === "POST") {
        return await link(folder, await readJson(req));
      }
      if (route.startsWith("/v1/storage/files/")) {
        let decoded: string;
        try {
          decoded = route
            .slice("/v1/storage/files/".length)
            .split("/")
            .map((segment) => decodeURIComponent(segment))
            .join("/");
        } catch {
          return err(400, "invalid_key", "The file key isn't valid.");
        }
        // The router trims trailing slashes; a folder delete says so explicitly.
        const folderKey = url.searchParams.get("folder") === "1";
        const key = validateStorageKey(
          folderKey ? `${decoded}/` : decoded,
          folderKey ? "folder" : "file",
        );
        if (key === null) {
          return err(
            400,
            "invalid_key",
            'File keys look like "photos/2026/cat.jpg": no leading "/", no "..", at most 512 characters.',
          );
        }
        if (method === "PUT" && !folderKey) return await put(folder, limitBytes, key, req);
        if ((method === "GET" || method === "HEAD") && !folderKey) {
          return await get(folder, key, req, res);
        }
        if (method === "DELETE") return await remove(folder, key);
      }
      return err(404, "not_found", `No ${method} ${route} in the Uno App API.`);
    } catch (cause) {
      if (cause instanceof StorageFailure) return cause.reply;
      const message = cause instanceof Error ? cause.message : String(cause);
      return err(502, "storage_unreachable", `Cloud storage failed: ${message.slice(0, 200)}`);
    }
  };

  return {
    usage,
    cachedUsage: (folder) => usageCache.get(folder) ?? null,
    deleteFolder,
    bucketId: async () => {
      try {
        return await ensureBucket(await cloudDeps());
      } catch {
        return null;
      }
    },
    handle,
  };
}
