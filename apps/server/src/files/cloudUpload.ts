/**
 * Uploads into a bucket from this computer: where the bytes come from. The
 * uploader itself (one PUT or parts, as the console says) is shared with the
 * browser, see `@t3tools/shared/cloudUpload`.
 *
 * @module files/cloudUpload
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import {
  CloudUploadError,
  type UploadBodyFactory,
  type UploadSource,
} from "@t3tools/shared/cloudUpload";

export {
  CloudUploadError,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_PART_CONCURRENCY,
  UPLOAD_PRESIGN_TTL_SECONDS,
  bytesUploadSource,
  missingPartsFrom,
  uploadToBucket,
} from "@t3tools/shared/cloudUpload";
export type {
  CloudUploadErrorCode,
  CloudUploadInput,
  CloudUploadResult,
  FetchLike,
  PresignCall,
  UploadBody,
  UploadBodyFactory,
  UploadSource,
} from "@t3tools/shared/cloudUpload";

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
