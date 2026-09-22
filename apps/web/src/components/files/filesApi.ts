/**
 * Talking to the daemon for the Files app: react-query keys, reading a file's
 * bytes (HTTP, Range-capable, falls back to the WS reader), saving atomically,
 * uploading, and the address share links live at.
 *
 * Writes never replace a file in place: bytes go to a hidden temp name next to
 * it first and are then renamed over it (rename(2) is atomic), so a dropped
 * connection mid-save or mid-upload never leaves a half-written document.
 */
import {
  FILES_RAW_ROUTE_PATH,
  type EnvironmentId,
  type FilesConflictPolicy,
  type FilesEntry,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureEnvironmentApi, readEnvironmentApi } from "../../environmentApi";
import { environmentFetchResponse, isPrimaryEnvironmentId } from "../../environments/http/target";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import {
  PROJECT_UPLOAD_CHUNK_BYTES,
  uploadFilesIntoDirectory,
  type ProjectUploadFile,
  type ProjectUploadProgress,
} from "../../projectUpload";
import { basename, dirname, joinPath } from "./fileTypes";

export const filesQueryKeys = {
  all: ["files"] as const,
  list: (environmentId: EnvironmentId | null, path: string | null, showHidden: boolean) =>
    ["files", "list", environmentId, path, showHidden] as const,
  search: (environmentId: EnvironmentId | null, path: string | null, query: string) =>
    ["files", "search", environmentId, path, query] as const,
  stat: (environmentId: EnvironmentId | null, path: string) =>
    ["files", "stat", environmentId, path] as const,
  bytes: (environmentId: EnvironmentId | null, path: string, modifiedAt: string) =>
    ["files", "bytes", environmentId, path, modifiedAt] as const,
  shares: (environmentId: EnvironmentId | null, path: string | null) =>
    ["files", "shares", environmentId, path] as const,
};

export function filesApi(environmentId: EnvironmentId | null) {
  if (environmentId === null) throw new Error("This computer isn't connected.");
  return ensureEnvironmentApi(environmentId).files;
}

export function filesListQueryOptions(
  environmentId: EnvironmentId | null,
  path: string | null,
  showHidden: boolean,
) {
  return queryOptions({
    queryKey: filesQueryKeys.list(environmentId, path, showHidden),
    queryFn: () => filesApi(environmentId).list({ ...(path ? { path } : {}), showHidden }),
    enabled: environmentId !== null,
    staleTime: 5_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

export function filesSearchQueryOptions(
  environmentId: EnvironmentId | null,
  path: string | null,
  query: string,
) {
  return queryOptions({
    queryKey: filesQueryKeys.search(environmentId, path, query),
    queryFn: () => filesApi(environmentId).search({ ...(path ? { path } : {}), query }),
    enabled: environmentId !== null && query.trim().length > 0,
    staleTime: 10_000,
  });
}

export function filesStatQueryOptions(environmentId: EnvironmentId | null, path: string) {
  return queryOptions({
    queryKey: filesQueryKeys.stat(environmentId, path),
    queryFn: () => filesApi(environmentId).stat({ path }),
    enabled: environmentId !== null,
    staleTime: 2_000,
    retry: 1,
  });
}

export function filesSharesQueryOptions(environmentId: EnvironmentId | null, path: string | null) {
  return queryOptions({
    queryKey: filesQueryKeys.shares(environmentId, path),
    queryFn: () => filesApi(environmentId).listShares(path ? { path } : {}),
    enabled: environmentId !== null,
    staleTime: 5_000,
  });
}

// ── Bytes ──────────────────────────────────────────────────────────────────

/** Largest file the browser reads whole (viewers); bigger ones are download-only. */
export const FILES_VIEW_MAX_BYTES = 200 * 1024 * 1024;
/** The WS reader's hard ceiling, used only when HTTP isn't reachable. */
const WS_READ_MAX_BYTES = 25 * 1024 * 1024;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/** The whole file, as bytes. */
export async function readFileBytes(
  environmentId: EnvironmentId,
  path: string,
): Promise<ArrayBuffer> {
  try {
    const response = await environmentFetchResponse({
      environmentId,
      pathname: FILES_RAW_ROUTE_PATH,
      searchParams: { path },
    });
    return await response.arrayBuffer();
  } catch (httpError) {
    // Opened through a proxy that doesn't pass HTTP through: the WS reader
    // still works for anything up to its 25 MB ceiling.
    const api = readEnvironmentApi(environmentId);
    if (!api) throw httpError;
    const result = await api.filesystem.readFile({ path, maxBytes: WS_READ_MAX_BYTES });
    if (result.truncated) {
      throw new Error("This file is too big to open here. Download it instead.", {
        cause: httpError,
      });
    }
    const bytes =
      result.encoding === "base64"
        ? base64ToBytes(result.content)
        : new TextEncoder().encode(result.content);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}

export async function readFileText(environmentId: EnvironmentId, path: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await readFileBytes(environmentId, path));
}

/**
 * Save a file in the browser's downloads. On the machine serving this page a
 * plain link streams straight from the daemon; elsewhere the bytes come
 * through the authenticated fetch first.
 */
export async function downloadFile(environmentId: EnvironmentId, path: string): Promise<void> {
  const name = basename(path);
  if (isPrimaryEnvironmentId(environmentId)) {
    const url = resolvePrimaryEnvironmentHttpUrl(FILES_RAW_ROUTE_PATH, { path, download: "1" });
    clickDownload(url, name);
    return;
  }
  const bytes = await readFileBytes(environmentId, path);
  const url = URL.createObjectURL(new Blob([bytes]));
  clickDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function clickDownload(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

// ── Writes ─────────────────────────────────────────────────────────────────

function tempName(name: string, purpose: "saving" | "upload"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `.${name}.uno-${purpose}-${random}`;
}

/** Write `contents` to a hidden temp file in `directory`; returns its path. */
async function writeStaged(
  environmentId: EnvironmentId,
  directory: string,
  name: string,
  contents: Uint8Array,
): Promise<string> {
  const api = ensureEnvironmentApi(environmentId);
  const staged = tempName(name, "saving");
  if (contents.byteLength === 0) {
    await api.projects.writeFile({
      cwd: directory,
      relativePath: staged,
      contents: "",
      encoding: "base64",
    });
  }
  for (let offset = 0; offset < contents.byteLength; offset += PROJECT_UPLOAD_CHUNK_BYTES) {
    await api.projects.writeFile({
      cwd: directory,
      relativePath: staged,
      contents: bytesToBase64(contents.subarray(offset, offset + PROJECT_UPLOAD_CHUNK_BYTES)),
      encoding: "base64",
      ...(offset === 0 ? {} : { mode: "append" as const }),
    });
  }
  return joinPath(directory, staged);
}

/** Replace a file's contents atomically (temp file + rename over it). */
export async function saveFile(
  environmentId: EnvironmentId,
  path: string,
  contents: string | Uint8Array | ArrayBuffer,
): Promise<FilesEntry> {
  const bytes =
    typeof contents === "string"
      ? new TextEncoder().encode(contents)
      : contents instanceof Uint8Array
        ? contents
        : new Uint8Array(contents);
  const directory = dirname(path);
  const name = basename(path);
  const staged = await writeStaged(environmentId, directory, name, bytes);
  const api = ensureEnvironmentApi(environmentId);
  try {
    return await api.files.rename({ path: staged, newName: name, onConflict: "replace" });
  } catch (error) {
    await api.files.delete({ paths: [staged] }).catch(() => undefined);
    throw error;
  }
}

/** Create a new file (never overwrites: a taken name gets " (2)"). */
export async function createFile(
  environmentId: EnvironmentId,
  directory: string,
  name: string,
  contents: string | Uint8Array,
): Promise<FilesEntry> {
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  const staged = await writeStaged(environmentId, directory, name, bytes);
  return ensureEnvironmentApi(environmentId).files.rename({
    path: staged,
    newName: name,
    onConflict: "keepBoth",
  });
}

export interface FilesUploadOptions {
  readonly environmentId: EnvironmentId;
  readonly targetDir: string;
  readonly files: ReadonlyArray<ProjectUploadFile>;
  /** `keepBoth` for new uploads; `replace` for "upload a new version". */
  readonly onConflict: FilesConflictPolicy;
  readonly onProgress?: (progress: ProjectUploadProgress) => void;
  readonly signal?: AbortSignal;
}

/**
 * Upload files (folders keep their structure) into `targetDir`, 3 MB at a
 * time over the daemon connection. Each file appears under its real name
 * only once all of it has arrived.
 */
export async function uploadIntoFolder(options: FilesUploadOptions) {
  const api = ensureEnvironmentApi(options.environmentId);
  const staged = new Map<string, string>();
  const stagedPathFor = (relativePath: string) => {
    const slash = relativePath.lastIndexOf("/");
    const folder = slash === -1 ? "" : relativePath.slice(0, slash + 1);
    const name = relativePath.slice(slash + 1);
    const path = `${folder}${tempName(name, "upload")}`;
    staged.set(relativePath, path);
    return path;
  };
  try {
    return await uploadFilesIntoDirectory(
      { writeFile: (write) => api.projects.writeFile(write) },
      {
        targetDir: options.targetDir,
        files: options.files,
        filterIgnored: false,
        stagedPathFor,
        onFileWritten: async ({ relativePath, stagedRelativePath }) => {
          await api.files.rename({
            path: joinPath(options.targetDir, stagedRelativePath),
            newName: basename(relativePath),
            onConflict: options.onConflict,
          });
          staged.delete(relativePath);
        },
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  } catch (error) {
    // Leave nothing half-uploaded behind.
    for (const path of staged.values()) {
      await api.files.delete({ paths: [joinPath(options.targetDir, path)] }).catch(() => undefined);
    }
    throw error;
  }
}
