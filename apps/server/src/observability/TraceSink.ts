import { AsyncRotatingFileSink } from "@t3tools/shared/logging";
import { Effect, Queue, Semaphore } from "effect";

import type { TraceRecord } from "./TraceRecord.ts";

// Records per batch before push asks for an early flush (upstream: 256).
const FLUSH_BUFFER_THRESHOLD = 256;
// While a write is slow, push keeps up to one trace file of records (at least
// 4 MiB), so the spans that time a stall still reach the file. Only a disk that
// stays stuck drops records, instead of growing memory without bound.
const MIN_BUFFER_BYTES = 4 * 1024 * 1024;

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

/**
 * Batches trace records and appends them off the event loop.
 *
 * Before: every 32 records `push` ran a synchronous `appendFileSync` (plus
 * rotation renames) on the event loop, and a failed chunk was put back with an
 * unbounded `buffer.unshift`. Now writes go through node:fs/promises, the
 * in-memory backlog is capped, and a failing disk drops records (logged once
 * per failure episode) instead of retrying a growing backlog.
 * Upstream t3code 570b72d839 + 4befc863f5.
 */
export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = new AsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  });
  const maxBufferBytes = Math.max(options.maxBytes, MIN_BUFFER_BYTES);

  let buffer: Array<{ readonly text: string; readonly bytes: number }> = [];
  let bufferBytes = 0;
  // A failure episode starts at the first dropped record and ends when a flush
  // sees that the latest write succeeded.
  let writeFailing = false;
  let droppedCount = 0;
  let failureReported = false;

  const flushRequests = yield* Queue.sliding<void>(1);
  const flushSemaphore = yield* Semaphore.make(1);

  const flushBuffered = Effect.gen(function* () {
    if (buffer.length === 0) {
      return;
    }
    const records = buffer;
    buffer = [];
    bufferBytes = 0;
    let persistedCount = 0;
    while (persistedCount < records.length) {
      // push drops any record larger than a file, so the first one always fits.
      let nextIndex = persistedCount + 1;
      let chunkBytes = records[persistedCount]!.bytes;
      while (nextIndex < records.length) {
        const nextRecordBytes = records[nextIndex]!.bytes;
        if (chunkBytes + nextRecordBytes > options.maxBytes) break;
        chunkBytes += nextRecordBytes;
        nextIndex += 1;
      }
      const chunk = records
        .slice(persistedCount, nextIndex)
        .map((record) => record.text)
        .join("");
      const written = yield* Effect.tryPromise(() => sink.write(chunk)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!written) {
        // A failing disk (ENOSPC, EACCES, EIO) drops the rest of the batch.
        // Retrying it would grow the backlog, and every later flush would
        // retry all of it.
        writeFailing = true;
        droppedCount += records.length - persistedCount;
        return;
      }
      writeFailing = false;
      persistedCount = nextIndex;
    }
  });

  // Logs once when writes start failing and once when they recover, so a disk
  // that stays broken costs one line, not one per flush.
  const flush = flushSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const droppedAtStart = droppedCount;
        yield* flushBuffered;
        if (droppedCount > 0 && !failureReported) {
          failureReported = true;
          yield* Effect.logWarning(
            "Trace writer could not keep up, dropping records until it recovers",
            { filePath: options.filePath },
          );
        } else if (failureReported && !writeFailing && droppedCount === droppedAtStart) {
          yield* Effect.logInfo("Trace writes recovered", {
            filePath: options.filePath,
            droppedCount,
          });
          failureReported = false;
          droppedCount = 0;
        }
      }),
    )
    .pipe(
      // A cancelled write still completes in the OS. Finish it before another
      // flush rotates the file or the scope's finalizer drains the rest.
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
    );

  yield* Effect.addFinalizer(() =>
    flush.pipe(
      Effect.andThen(Effect.promise(() => sink.drain())),
      Effect.ignore,
    ),
  );
  yield* Effect.forkScoped(
    // Flush when push fills a batch or the batch window passes.
    Queue.take(flushRequests).pipe(
      Effect.timeoutOption(`${options.batchWindowMs} millis`),
      Effect.andThen(flush),
      Effect.forever,
    ),
  );

  return {
    filePath: options.filePath,
    push(record) {
      try {
        const text = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(text);
        if (bytes > options.maxBytes) return;
        if (bufferBytes + bytes > maxBufferBytes) {
          droppedCount += 1;
          return;
        }
        buffer.push({ text, bytes });
        bufferBytes += bytes;
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          Queue.offerUnsafe(flushRequests, undefined);
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => flush.pipe(Effect.andThen(Effect.promise(() => sink.drain()))),
  } satisfies TraceSink;
});
