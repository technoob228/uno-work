/**
 * One upload into a bucket of the Uno account's cloud, of any size.
 *
 * The console decides how a file travels (`POST /api/v1/buckets/{id}/presign`
 * with `method: "put"` and the file's `size`):
 *
 * - one presigned URL (`{url, max_bytes?}`) → one PUT of the whole file. R2
 *   buckets take up to ~4.9 GiB this way; old consoles answer without
 *   `max_bytes` and ignore `size`.
 * - parts (`{multipart: true, upload_id, part_size, parts, first, part_urls}`)
 *   when the file is bigger than one PUT of the bucket's storage takes
 *   (Hostkey: 50 MB). Part n is bytes [(n-1)*part_size, n*part_size), PUT with
 *   no extra headers. Links that expired are signed again (`method: "put"`
 *   with `upload_id, first, last`), the upload is finished with
 *   `method: "complete"` (the console would also finish it by itself within
 *   ~30 s) and dropped with `method: "abort"` when it can't go on.
 *
 * Work never caps the size itself: the console knows the bucket's storage and
 * the account's quota (402) and answers accordingly.
 *
 * Bytes are streamed: a file on disk is read part by part straight from the
 * disk; a request body (App SDK) is cut into parts as it arrives, holding at
 * most `concurrency` parts in memory.
 *
 * @module files/cloudUpload
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { controlPlaneErrorStatus } from "../workspaceRegistry/unoCloudParse.ts";

/** Presigned links live an hour (the console clamps to that too). */
export const UPLOAD_PRESIGN_TTL_SECONDS = 3600;
/** Parts in flight at once. */
export const UPLOAD_PART_CONCURRENCY = 4;
/** Tries per part (and per whole-file PUT that can be read again): 1 + 3 retries. */
export const UPLOAD_PART_ATTEMPTS = 4;
/** First pause before a retry; doubles each time. */
const UPLOAD_BACKOFF_MS = 1000;
/** How many part links one re-sign asks for. */
const RESIGN_BATCH = 64;
/** Tries of `complete` when the console doesn't answer. */
const COMPLETE_ATTEMPTS = 3;
/** Rounds of "re-upload the parts the console says are missing, complete again". */
const COMPLETE_REPAIR_ROUNDS = 2;

export type CloudUploadErrorCode =
  /** Storage didn't answer (network). */
  | "storage_unreachable"
  /** Storage answered an error status (`status`). */
  | "storage_refused"
  /** The console's answer to presign had no usable address or plan. */
  | "bad_console_answer"
  /** The bytes to upload ended early or couldn't be read. */
  | "source_failed";

/** A failed upload that isn't a console error (those are thrown as they came). */
export class CloudUploadError extends Error {
  readonly code: CloudUploadErrorCode;
  /** HTTP status from storage; 0 when there was none. */
  readonly status: number;
  constructor(code: CloudUploadErrorCode, message: string, status = 0) {
    super(message);
    this.name = "CloudUploadError";
    this.code = code;
    this.status = status;
  }
}

/** One request body: a fresh one each time the factory is called. */
export interface UploadBody {
  readonly body: Uint8Array | ReadableStream;
  readonly length: number;
}
export type UploadBodyFactory = () => UploadBody;

/** What gets uploaded. */
export interface UploadSource {
  readonly size: number;
  /** Ranges can be read again (and out of order) — a file on disk or bytes in memory. */
  readonly rereadable: boolean;
  /** The whole object, for one PUT. */
  readonly whole: () => UploadBodyFactory;
  /**
   * Bytes [start, end). The uploader asks for ranges in ascending order and
   * one at a time; the factory it gets can be called again for a retry.
   */
  readonly range: (start: number, end: number) => Promise<UploadBodyFactory>;
}

/** A file on disk: every body is a new read stream of just its range. */
export function fileUploadSource(path: string, size: number): UploadSource {
  const stream =
    (start: number, end: number): UploadBodyFactory =>
    () => ({
      body:
        end <= start
          ? new Uint8Array()
          : (Readable.toWeb(createReadStream(path, { start, end: end - 1 })) as ReadableStream),
      length: Math.max(0, end - start),
    });
  return {
    size,
    rereadable: true,
    whole: () => stream(0, size),
    range: async (start, end) => stream(start, end),
  };
}

/** Bytes already in memory. */
export function bytesUploadSource(bytes: Uint8Array): UploadSource {
  const slice =
    (start: number, end: number): UploadBodyFactory =>
    () => ({
      body: bytes.subarray(start, end),
      length: end - start,
    });
  return {
    size: bytes.length,
    rereadable: true,
    whole: () => slice(0, bytes.length),
    range: async (start, end) => slice(start, end),
  };
}

/**
 * A stream read once (an HTTP request body). One PUT gets the stream itself;
 * parts are cut from it in order and kept in memory until they are uploaded.
 */
export function streamUploadSource(stream: Readable, size: number): UploadSource {
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let pending: Uint8Array = new Uint8Array();
  let position = 0;
  const readExactly = async (length: number): Promise<Uint8Array> => {
    iterator ??= (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      if (pending.length === 0) {
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch (cause) {
          throw new CloudUploadError(
            "source_failed",
            `the file stopped arriving (${cause instanceof Error ? cause.message : String(cause)})`,
          );
        }
        if (next.done) {
          throw new CloudUploadError(
            "source_failed",
            `the file ended after ${position + filled} of ${size} bytes`,
          );
        }
        pending =
          typeof next.value === "string"
            ? new TextEncoder().encode(next.value)
            : new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      }
      const take = Math.min(length - filled, pending.length);
      out.set(pending.subarray(0, take), filled);
      pending = pending.subarray(take);
      filled += take;
    }
    position += length;
    return out;
  };
  return {
    size,
    rereadable: false,
    whole: () => () => ({
      body: size === 0 ? new Uint8Array() : (Readable.toWeb(stream) as ReadableStream),
      length: size,
    }),
    range: async (start, end) => {
      if (start !== position) {
        throw new CloudUploadError("source_failed", "parts of a stream must be read in order");
      }
      const bytes = await readExactly(end - start);
      return () => ({ body: bytes, length: bytes.length });
    },
  };
}

/** `fetch` or a stand-in (tests). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** POST /api/v1/buckets/{id}/presign with this body; console errors are thrown as they come. */
export type PresignCall = (body: Record<string, unknown>) => Promise<unknown>;

export interface CloudUploadInput {
  readonly presign: PresignCall;
  readonly fetchImpl?: FetchLike | undefined;
  /** The key inside the bucket. */
  readonly key: string;
  readonly source: UploadSource;
  /** Kept on the object (sent to the console, and as a header on one PUT). */
  readonly contentType?: string | undefined;
  /** Bytes stored so far (after each part; once at the end of one PUT). */
  readonly onProgress?: ((uploadedBytes: number, totalBytes: number) => void) | undefined;
  readonly concurrency?: number | undefined;
  /** Tests: no real waiting. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface CloudUploadResult {
  readonly multipart: boolean;
  readonly parts: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Statuses worth another try of the same PUT. */
function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

type PutOutcome = { readonly ok: true } | { readonly ok: false; readonly status: number };

async function putOnce(
  fetchImpl: FetchLike,
  url: string,
  make: UploadBodyFactory,
  headers: Record<string, string>,
): Promise<PutOutcome> {
  let response: Response;
  try {
    const { body, length } = make();
    const streamed = !(body instanceof Uint8Array);
    response = await fetchImpl(url, {
      method: "PUT",
      body: body as RequestInit["body"],
      headers: { ...headers, "content-length": String(length) },
      ...(streamed ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch {
    return { ok: false, status: 0 };
  }
  await response.body?.cancel().catch(() => undefined);
  return response.ok ? { ok: true } : { ok: false, status: response.status };
}

function storageError(status: number): CloudUploadError {
  return status === 0
    ? new CloudUploadError("storage_unreachable", "couldn't reach storage")
    : new CloudUploadError("storage_refused", `storage answered ${status}`, status);
}

/** Part numbers the console lists in "… parts are not uploaded yet …: 3, 5, 7 … (+12)". */
export function missingPartsFrom(cause: unknown): number[] {
  const message = cause instanceof Error ? cause.message : String(cause);
  const match = /not uploaded yet[^:]*:\s*([\d,\s]+)/.exec(message);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Upload `source` under `key`: one PUT or parts, whichever the console says. */
export async function uploadToBucket(input: CloudUploadInput): Promise<CloudUploadResult> {
  const { source, key } = input;
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = input.sleep ?? realSleep;
  const answer = record(
    await input.presign({
      key,
      method: "put",
      size: source.size,
      ttl: UPLOAD_PRESIGN_TTL_SECONDS,
      ...(input.contentType ? { content_type: input.contentType } : {}),
    }),
  );

  if (answer["multipart"] === true) {
    return uploadParts(input, answer, fetchImpl, sleep);
  }

  // One PUT. `max_bytes` (new consoles) is the console's business: had the
  // file been bigger, it would have answered with parts.
  const url = answer["url"];
  if (!isHttpUrl(url)) {
    throw new CloudUploadError("bad_console_answer", "the console didn't return an upload address");
  }
  const headers: Record<string, string> = {};
  if (input.contentType) headers["content-type"] = input.contentType;
  const make = source.whole();
  // Retry only a link the console vouched for (`max_bytes`, new consoles): an
  // old console's link to Hostkey fails every time for files over ~95 MiB,
  // and sending gigabytes again won't change that.
  const vouched = typeof answer["max_bytes"] === "number";
  const attempts = source.rereadable && vouched ? UPLOAD_PART_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await putOnce(fetchImpl, url, make, headers);
    if (outcome.ok) break;
    if (attempt >= attempts || !retryable(outcome.status)) throw storageError(outcome.status);
    await sleep(UPLOAD_BACKOFF_MS * 2 ** (attempt - 1));
  }
  input.onProgress?.(source.size, source.size);
  return { multipart: false, parts: 1 };
}

async function uploadParts(
  input: CloudUploadInput,
  answer: Record<string, unknown>,
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void>,
): Promise<CloudUploadResult> {
  const { source, key } = input;
  const size = source.size;
  const uploadId = typeof answer["upload_id"] === "string" ? answer["upload_id"] : "";
  const partSize = positiveInt(answer["part_size"]);
  const parts = positiveInt(answer["parts"]);
  if (!uploadId) {
    throw new CloudUploadError("bad_console_answer", "the console started an upload without an id");
  }
  const abort = () =>
    input.presign({ key, method: "abort", upload_id: uploadId }).catch(() => undefined);
  if (
    partSize === null ||
    parts === null ||
    parts !== Math.ceil(size / partSize) ||
    (answer["size"] !== undefined && answer["size"] !== size)
  ) {
    await abort();
    throw new CloudUploadError(
      "bad_console_answer",
      "the console's plan of parts doesn't match the file's size",
    );
  }

  const urls = new Map<number, string>();
  const remember = (raw: Record<string, unknown>) => {
    const first = positiveInt(raw["first"]) ?? 1;
    const list = Array.isArray(raw["part_urls"]) ? raw["part_urls"] : [];
    list.forEach((url, index) => {
      if (isHttpUrl(url)) urls.set(first + index, url);
    });
  };
  remember(answer);

  const resign = async (part: number) => {
    remember(
      record(
        await input.presign({
          key,
          method: "put",
          upload_id: uploadId,
          first: part,
          last: Math.min(parts, part + RESIGN_BATCH - 1),
          ttl: UPLOAD_PRESIGN_TTL_SECONDS,
        }),
      ),
    );
  };

  const bounds = (part: number) => {
    const start = (part - 1) * partSize;
    return { start, end: Math.min(size, start + partSize) };
  };

  // The first error that stops the upload (the other parts stop too).
  const state = { failure: null as { cause: unknown } | null };

  const putPart = async (part: number, make: UploadBodyFactory) => {
    for (let attempt = 1; ; attempt += 1) {
      if (state.failure) return;
      let url = urls.get(part);
      if (!url) {
        await resign(part);
        url = urls.get(part);
        if (!url) {
          throw new CloudUploadError(
            "bad_console_answer",
            `the console didn't sign a link for part ${part}`,
          );
        }
      }
      const outcome = await putOnce(fetchImpl, url, make, {});
      if (outcome.ok) return;
      // 403: the link expired (an upload longer than an hour) — sign it again.
      const expired = outcome.status === 403;
      if (attempt >= UPLOAD_PART_ATTEMPTS || (!expired && !retryable(outcome.status))) {
        throw storageError(outcome.status);
      }
      if (expired) {
        // Another part may have re-signed this one already.
        if (urls.get(part) === url) urls.delete(part);
      } else {
        await sleep(UPLOAD_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  };

  // A stream gives its parts only in order: reads go one after another.
  let reading: Promise<unknown> = Promise.resolve();
  const read = (part: number): Promise<UploadBodyFactory> => {
    const { start, end } = bounds(part);
    const next = reading.then(() => source.range(start, end));
    reading = next.catch(() => undefined);
    return next;
  };

  let uploaded = 0;
  const done = (part: number) => {
    const { start, end } = bounds(part);
    uploaded += end - start;
    input.onProgress?.(uploaded, size);
  };

  const runParts = async (numbers: ReadonlyArray<number>) => {
    let index = 0;
    const worker = async () => {
      while (!state.failure && index < numbers.length) {
        const part = numbers[index]!;
        index += 1;
        try {
          const make = await read(part);
          if (state.failure) return;
          await putPart(part, make);
          if (!state.failure) done(part);
        } catch (cause) {
          state.failure ??= { cause };
        }
      }
    };
    const workers = Math.max(
      1,
      Math.min(input.concurrency ?? UPLOAD_PART_CONCURRENCY, numbers.length),
    );
    await Promise.all(Array.from({ length: workers }, worker));
  };

  // Throws the error that stopped the parts, after dropping the upload.
  const throwIfFailed = async () => {
    const failure = state.failure;
    if (!failure) return;
    await abort();
    throw failure.cause;
  };

  await runParts(Array.from({ length: parts }, (_, index) => index + 1));
  await throwIfFailed();

  // Every part is in: finish now rather than wait for the console's worker.
  for (let attempt = 1, repairs = 0; ; ) {
    try {
      await input.presign({ key, method: "complete", upload_id: uploadId });
      break;
    } catch (cause) {
      const status = controlPlaneErrorStatus(cause);
      if (status === null || status === 429 || status >= 500) {
        // The console didn't answer: it assembles the parts by itself.
        if (attempt >= COMPLETE_ATTEMPTS) break;
        await sleep(UPLOAD_BACKOFF_MS * 2 ** (attempt - 1));
        attempt += 1;
        continue;
      }
      const missing = status === 400 ? missingPartsFrom(cause).filter((n) => n <= parts) : [];
      if (missing.length > 0 && source.rereadable && repairs < COMPLETE_REPAIR_ROUNDS) {
        repairs += 1;
        uploaded = Math.max(
          0,
          uploaded - missing.reduce((sum, n) => sum + bounds(n).end - bounds(n).start, 0),
        );
        await runParts(missing);
        await throwIfFailed();
        continue;
      }
      await abort();
      throw cause;
    }
  }
  return { multipart: true, parts };
}
