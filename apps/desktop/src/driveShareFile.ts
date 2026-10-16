/**
 * "Share with a link…" for a file on this Mac (w0139, Misha 16.10 point 8):
 * the laptop isn't reachable from the internet, so a copy goes to the
 * person's Cloud storage (Uno Drive → `Shared/`) and the link is to that
 * copy — it keeps working while the laptop sleeps.
 *
 * Done here, in the main process, with the desktop's own Uno sign-in (the
 * `work:interface` token never leaves this process), so it works without an
 * account key in the local daemon's settings — which most people on a laptop
 * don't have. Only console routes that token may call:
 *
 *   1. POST /api/v1/drive/upload-link {folder: "Shared"} → a one-time upload
 *      address (1 hour);
 *   2. POST <that address>?name=<file name>, the bytes, with their length
 *      (the console refuses chunked bodies) → {key};
 *   3. POST /api/v1/drive/shares {key, expires_in_hours} → the link.
 *
 * A second share of the same file uploads a new copy (Uno Drive keeps both
 * names apart), so the link is always to "the file as it is now".
 *
 * Private-looking files (hidden files and folders, SSH and TLS keys) are
 * refused here whatever the app asks.
 */
import * as Path from "node:path";

import { parseDriveShare } from "@t3tools/shared/unoDrive";

/** The console's cap for one upload through the upload address. */
export const MAX_SHARE_UPLOAD_BYTES = 2 * 1024 ** 3;
export const SHARED_COPIES_FOLDER = "Shared";
const DEFAULT_EXPIRES_IN_HOURS = 24 * 7;
const MAX_EXPIRES_IN_HOURS = 24 * 365;

export interface DriveShareFileInput {
  readonly path: string;
  readonly expiresInHours?: number | undefined;
}

export type DriveShareFileResult =
  | {
      readonly ok: true;
      readonly key: string;
      readonly url: string;
      readonly expiresAt: string | null;
    }
  | { readonly ok: false; readonly error: string };

export interface DriveShareFileDeps {
  readonly homeDir: string;
  /** Account call with the desktop token (UnoAccountService.request). */
  readonly accountRequest: (input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  }) => Promise<{ readonly status: number; readonly body: unknown }>;
  /** realpath + stat of the file. */
  readonly inspect: (
    path: string,
  ) => Promise<{ readonly realPath: string; readonly isFile: boolean; readonly size: number }>;
  /** POST the file's bytes (fixed length) to the upload address; status and JSON body. */
  readonly upload: (input: {
    readonly url: string;
    readonly filePath: string;
    readonly size: number;
    readonly contentType: string;
  }) => Promise<{ readonly status: number; readonly body: unknown }>;
}

const SECRET_NAME =
  /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|.*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|gpg|asc))$/i;

/** Why a path can't be shared (a sentence for the person), or null. */
export function shareablePathProblem(realPath: string, homeDir: string): string | null {
  const relative = Path.relative(homeDir, realPath);
  if (!relative || relative.startsWith("..") || Path.isAbsolute(relative)) {
    return "Only files in your home folder can be shared with a link.";
  }
  const segments = relative.split(Path.sep);
  if (segments.some((segment) => segment.startsWith("."))) {
    return "Hidden files and folders aren't shared with a link: they often hold keys and settings.";
  }
  if (SECRET_NAME.test(segments.at(-1) ?? "")) {
    return "This looks like a key file. Keys aren't shared with a link.";
  }
  return null;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A hint for the console (it stores a safe type of its own choosing anyway). */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[Path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** The one-time upload address must be the console's upload route over https. */
export function isUploadAddress(raw: unknown, consoleUrl: string): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    const dev = new URL(consoleUrl);
    const secure = url.protocol === "https:" || (url.protocol === "http:" && url.host === dev.host);
    return (
      secure && /^\/api\/v1\/drive\/u\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname) && !url.search
    );
  } catch {
    return false;
  }
}

function consoleProblem(status: number, body: unknown, what: string): string {
  const code =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "";
  if (status === 401 || code === "NOT_SIGNED_IN") {
    return "Sign in with Uno (Settings → Uno account) to share files with a link.";
  }
  if (status === 402 || code === "STORAGE_QUOTA_EXCEEDED") {
    return "Cloud storage is full. Free up space or upgrade your plan.";
  }
  if (code === "DRIVE_NOT_CONFIGURED" || status === 404) {
    return "Uno Drive isn't available on this Uno console yet.";
  }
  if (status === 429 || code === "RATE_LIMITED") return "Too many tries. Wait a bit and try again.";
  if (status === 413 || code === "TOO_LARGE")
    return "This file is too big to share (2 GB at most).";
  return `${what} didn't work (the console answered ${status}). Try again.`;
}

export async function shareLocalFileViaDrive(
  deps: DriveShareFileDeps & { readonly consoleUrl: string },
  input: DriveShareFileInput,
): Promise<DriveShareFileResult> {
  if (typeof input.path !== "string" || input.path.trim() === "") {
    return { ok: false, error: "That file isn't on this computer." };
  }
  // The app names files from the home folder ("~/…") or in full.
  const raw = input.path.trim();
  const requested =
    raw === "~" || raw.startsWith("~/")
      ? Path.join(deps.homeDir, raw.slice(1))
      : Path.isAbsolute(raw)
        ? raw
        : Path.join(deps.homeDir, raw);
  let file: Awaited<ReturnType<DriveShareFileDeps["inspect"]>>;
  try {
    file = await deps.inspect(requested);
  } catch {
    return { ok: false, error: "That file isn't there anymore." };
  }
  if (!file.isFile)
    return { ok: false, error: "Only a file can be shared this way, not a folder." };
  const problem = shareablePathProblem(file.realPath, deps.homeDir);
  if (problem) return { ok: false, error: problem };
  if (file.size <= 0) return { ok: false, error: "This file is empty." };
  if (file.size > MAX_SHARE_UPLOAD_BYTES) {
    return { ok: false, error: "This file is too big to share (2 GB at most)." };
  }
  const hours = Math.min(
    Math.max(Math.trunc(input.expiresInHours ?? DEFAULT_EXPIRES_IN_HOURS), 1),
    MAX_EXPIRES_IN_HOURS,
  );

  const link = await deps.accountRequest({
    method: "POST",
    path: "/api/v1/drive/upload-link",
    body: { folder: SHARED_COPIES_FOLDER },
  });
  if (link.status !== 200) {
    return {
      ok: false,
      error: consoleProblem(link.status, link.body, "Getting an upload address"),
    };
  }
  const address = (link.body as { url?: unknown } | null)?.url;
  if (!isUploadAddress(address, deps.consoleUrl)) {
    return { ok: false, error: "The console didn't return an upload address." };
  }

  const name = Path.basename(file.realPath);
  let uploaded: { status: number; body: unknown };
  try {
    uploaded = await deps.upload({
      url: `${address}?name=${encodeURIComponent(name)}`,
      filePath: file.realPath,
      size: file.size,
      contentType: contentTypeFor(name),
    });
  } catch {
    return { ok: false, error: "Uploading the copy failed. Check the connection and try again." };
  }
  const key = (uploaded.body as { key?: unknown } | null)?.key;
  if (uploaded.status !== 201 || typeof key !== "string" || !key) {
    return {
      ok: false,
      error: consoleProblem(uploaded.status, uploaded.body, "Uploading the copy"),
    };
  }

  const shared = await deps.accountRequest({
    method: "POST",
    path: "/api/v1/drive/shares",
    body: { key, expires_in_hours: hours },
  });
  if (shared.status !== 200 && shared.status !== 201) {
    return { ok: false, error: consoleProblem(shared.status, shared.body, "Making the link") };
  }
  const share = parseDriveShare(shared.body);
  if (!share.url) return { ok: false, error: "The console didn't return a link." };
  return { ok: true, key, url: share.url, expiresAt: share.expiresAt };
}

/** realpath + stat with Node. */
export async function nodeInspectFile(path: string) {
  const FS = await import("node:fs");
  const realPath = await FS.promises.realpath(path);
  const stat = await FS.promises.stat(realPath);
  return { realPath, isFile: stat.isFile(), size: stat.size };
}

/** POST a file with a fixed Content-Length (the console refuses chunked uploads). */
export async function nodeUploadFile(input: {
  readonly url: string;
  readonly filePath: string;
  readonly size: number;
  readonly contentType: string;
}): Promise<{ status: number; body: unknown }> {
  const FS = await import("node:fs");
  const url = new URL(input.url);
  const transport =
    url.protocol === "http:" ? await import("node:http") : await import("node:https");
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": input.contentType,
          "Content-Length": String(input.size),
        },
        timeout: 60 * 60 * 1000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          if (length < 64 * 1024) chunks.push(chunk);
          length += chunk.length;
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // not JSON
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Upload timed out.")));
    request.on("error", reject);
    const stream = FS.createReadStream(input.filePath);
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });
}
