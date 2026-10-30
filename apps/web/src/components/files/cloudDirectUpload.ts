/**
 * Big files into Cloud storage straight from the browser. Going through the
 * computer (the old way, kept for small files) needs room on its disk for the
 * whole file; here only the signing goes through the daemon, which holds the
 * console's credentials, and the bytes go to storage directly.
 *
 * The console's answers are read by the same uploader the computer uses
 * (`@t3tools/shared/cloudUpload`); here live what is the browser's own: XHR,
 * which alone can tell how much of a request went out, and the choice of what
 * goes this way.
 */
import type { FilesCloudUploadStepInput, FilesCloudUploadStepResult } from "@t3tools/contracts";
import { CLOUD_VERSION_MAX_BYTES } from "@t3tools/contracts";
import {
  blobUploadSource,
  CloudUploadError,
  type FetchLike,
  type PresignCall,
  uploadToBucket,
} from "@t3tools/shared/cloudUpload";
import { ControlPlaneHttpError } from "@t3tools/shared/unoCloud";

import { isUnsafeRelativePath } from "../../firstProject";
import type { ProjectUploadFile } from "../../projectUpload";

/** Up to this a file can still go the old way when storage can't be reached. */
export const CLOUD_DISK_FALLBACK_MAX_BYTES = 1024 ** 3;

/** Tries per part once some of the file is stored: about a minute and a half. */
const PATIENT_PART_ATTEMPTS = 8;

export interface CloudUploadSplit {
  /** Bigger than a copy the computer keeps of a replaced file: past the disk. */
  readonly direct: ReadonlyArray<ProjectUploadFile>;
  /** Through the computer, as ever. */
  readonly staged: ReadonlyArray<ProjectUploadFile>;
  /** Hidden files inside a folder, which the computer's way leaves out too. */
  readonly leftOut: ReadonlyArray<ProjectUploadFile>;
}

export function splitCloudUpload(files: ReadonlyArray<ProjectUploadFile>): CloudUploadSplit {
  const direct: ProjectUploadFile[] = [];
  const staged: ProjectUploadFile[] = [];
  const leftOut: ProjectUploadFile[] = [];
  for (const file of files) {
    if (file.size <= CLOUD_VERSION_MAX_BYTES || isUnsafeRelativePath(file.relativePath)) {
      staged.push(file);
    } else if (
      file.relativePath
        .split("/")
        .slice(1)
        .some((segment) => segment.startsWith("."))
    ) {
      leftOut.push(file);
    } else {
      direct.push(file);
    }
  }
  return { direct, staged, leftOut };
}

/** The part of `XMLHttpRequest` an upload uses. */
export interface XhrLike {
  readonly status: number;
  readonly upload: {
    addEventListener(
      type: "progress",
      listener: (event: { readonly loaded: number }) => void,
    ): void;
  };
  addEventListener(type: "load" | "error" | "abort" | "timeout", listener: () => void): void;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
}

const urlOf = (input: string | URL | Request) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * `fetch` for the uploader, on XHR. `onSent` hears the bytes of each request
 * as they go, and `null` when the request is over.
 */
function xhrFetch(
  makeXhr: () => XhrLike,
  onSent: (request: object, sentBytes: number | null) => void,
): FetchLike {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(new DOMException("Upload cancelled.", "AbortError"));
        return;
      }
      const xhr = makeXhr();
      const request = {};
      const stop = () => xhr.abort();
      const finish = (settle: () => void) => {
        signal?.removeEventListener("abort", stop);
        onSent(request, null);
        settle();
      };
      const failed = () => finish(() => reject(new TypeError("The request didn't go through.")));
      signal?.addEventListener("abort", stop, { once: true });
      xhr.upload.addEventListener("progress", (event) => onSent(request, event.loaded));
      xhr.addEventListener("load", () => {
        if (xhr.status === 0) {
          failed();
          return;
        }
        finish(() => resolve(new Response(null, { status: xhr.status })));
      });
      xhr.addEventListener("error", failed);
      xhr.addEventListener("abort", failed);
      xhr.addEventListener("timeout", failed);
      xhr.open(init?.method ?? "PUT", urlOf(input));
      // The browser sets the length itself and refuses to be told.
      for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        if (name.toLowerCase() !== "content-length") xhr.setRequestHeader(name, value);
      }
      xhr.send(init?.body as Blob);
    });
}

/** The console said no: `detail` is its own text, the message is the person's. */
class CloudStepRefusal extends ControlPlaneHttpError {
  readonly friendly: string;
  constructor(status: number, detail: string, friendly: string) {
    super(status, detail);
    this.friendly = friendly;
  }
}

/** The daemon didn't take the step (no connection, or too old to know it). */
class CloudStepUnreachable extends Error {}

export type CloudUploadStep = (
  input: FilesCloudUploadStepInput,
) => Promise<FilesCloudUploadStepResult>;

function presignThrough(step: CloudUploadStep, bucketId: number): PresignCall {
  return async (body) => {
    const input = { bucketId, ...body } as FilesCloudUploadStepInput;
    const result = await step(input).catch((cause: unknown) => {
      throw new CloudStepUnreachable(cause instanceof Error ? cause.message : String(cause));
    });
    if (result.refusal) {
      const { status, message, detail } = result.refusal;
      throw status === null ? new Error(message) : new CloudStepRefusal(status, detail, message);
    }
    return result.answer;
  };
}

/** Nothing is stored yet and the old way is still open for this file. */
function canGoThroughComputer(error: unknown, file: ProjectUploadFile, stored: number): boolean {
  if (stored > 0 || file.size > CLOUD_DISK_FALLBACK_MAX_BYTES) return false;
  return (
    error instanceof CloudStepUnreachable ||
    (error instanceof CloudUploadError && error.code === "storage_unreachable")
  );
}

function failureFor(error: unknown, name: string): Error {
  if (error instanceof CloudUploadError && error.code === "cancelled") {
    return new DOMException("Upload cancelled.", "AbortError");
  }
  if (error instanceof CloudStepRefusal) return new Error(error.friendly);
  if (error instanceof CloudUploadError && error.code === "bad_console_answer") {
    return new Error("The console didn't return an upload address.");
  }
  if (error instanceof CloudUploadError || error instanceof CloudStepUnreachable) {
    return new Error(`Uploading “${name}” failed (${error.message}).`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface DirectUploadProgress {
  readonly sentBytes: number;
  readonly completedFiles: number;
  /** Null when a file has just finished. */
  readonly currentPath: string | null;
}

export interface DirectUploadResult {
  readonly uploaded: number;
  /** Storage couldn't be reached from this page: these go through the computer. */
  readonly fallback: ReadonlyArray<ProjectUploadFile>;
}

/**
 * Upload `files` one after another, each under `prefix` + its relative path.
 * The first failure stops the rest: what finished stays in the cloud, a file
 * in parts is dropped.
 */
export async function uploadFilesDirect(input: {
  readonly step: CloudUploadStep;
  readonly bucketId: number;
  readonly prefix: string;
  readonly files: ReadonlyArray<ProjectUploadFile>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DirectUploadProgress) => void;
  /** Tests. */
  readonly makeXhr?: () => XhrLike;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<DirectUploadResult> {
  const presign = presignThrough(input.step, input.bucketId);
  const makeXhr = input.makeXhr ?? (() => new XMLHttpRequest() as XhrLike);
  const fallback: ProjectUploadFile[] = [];
  let uploaded = 0;
  let finishedBytes = 0;
  for (const file of input.files) {
    // Parts confirmed by storage, and what is on its way in requests still open.
    let stored = 0;
    const inFlight = new Map<object, number>();
    const report = () => {
      const sending = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
      input.onProgress?.({
        sentBytes: finishedBytes + Math.min(file.size, stored + sending),
        completedFiles: uploaded,
        currentPath: file.relativePath,
      });
    };
    try {
      await uploadToBucket({
        presign,
        fetchImpl: xhrFetch(makeXhr, (request, sentBytes) => {
          if (sentBytes === null) inFlight.delete(request);
          else inFlight.set(request, sentBytes);
          report();
        }),
        key: `${input.prefix}${file.relativePath}`,
        source: blobUploadSource(file.blob),
        signal: input.signal,
        patientPartAttempts: PATIENT_PART_ATTEMPTS,
        onProgress: (storedBytes) => {
          stored = storedBytes;
          report();
        },
        sleep: input.sleep,
      });
    } catch (error) {
      if (canGoThroughComputer(error, file, stored)) {
        fallback.push(file);
        continue;
      }
      throw failureFor(error, file.relativePath);
    }
    uploaded += 1;
    finishedBytes += file.size;
    input.onProgress?.({
      sentBytes: finishedBytes,
      completedFiles: uploaded,
      currentPath: null,
    });
  }
  return { uploaded, fallback };
}
