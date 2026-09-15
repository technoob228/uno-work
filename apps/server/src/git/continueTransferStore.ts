/**
 * ContinueTransferStore - the bundle files "Continue on <machine>" moves
 * between two daemons through the client.
 *
 * The source writes `outgoing/<transferId>.bundle` and serves it chunk by
 * chunk; the target assembles `incoming/<transferId>.bundle` from the same
 * chunks and checks size + SHA-256 before git ever reads it. Both live under
 * the daemon's scratch directory and are removed after a successful handoff;
 * anything a crashed or abandoned run leaves behind is swept after a day.
 *
 * Transfer ids are validated by the RPC schema (UUIDs) and re-checked here,
 * so a request can never name a path outside the store.
 *
 * @module ContinueTransferStore
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import {
  THREAD_CONTINUE_CHUNK_BYTES,
  THREAD_CONTINUE_MAX_BUNDLE_BYTES,
  ThreadContinueError,
} from "@t3tools/contracts";
import { Effect } from "effect";

const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
/** A client may send a bit more than the source's chunk size; anything far above is refused. */
const MAX_WRITE_CHUNK_BYTES = 2 * THREAD_CONTINUE_CHUNK_BYTES;

export interface ContinueBundleDigest {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ContinueTransferStoreShape {
  /** Where the source writes the bundle for `transferId`; the folder exists afterwards. */
  readonly prepareOutgoing: (transferId: string) => Effect.Effect<string, ThreadContinueError>;
  /** Size and hash of a finished bundle (outgoing on the source, incoming on the target). */
  readonly digest: (
    side: "outgoing" | "incoming",
    transferId: string,
  ) => Effect.Effect<ContinueBundleDigest, ThreadContinueError>;
  readonly incomingPath: (transferId: string) => Effect.Effect<string, ThreadContinueError>;
  /** Base64 of chunk `index` of the outgoing bundle. */
  readonly readChunk: (input: {
    readonly transferId: string;
    readonly index: number;
  }) => Effect.Effect<string, ThreadContinueError>;
  /**
   * Writes a chunk of the incoming bundle at `offset`. Offset 0 starts over;
   * a chunk may be re-sent (the file is cut back to `offset` first), but a
   * gap before `offset` is refused.
   */
  readonly writeChunk: (input: {
    readonly transferId: string;
    readonly offset: number;
    readonly data: string;
  }) => Effect.Effect<number, ThreadContinueError>;
  /** Deletes both sides' files for `transferId`; true when something was removed. */
  readonly discard: (transferId: string) => Effect.Effect<boolean>;
  /** Removes bundles older than the TTL. Never fails. */
  readonly sweep: Effect.Effect<void>;
}

const fail = (
  reason: ThreadContinueError["reason"],
  message: string,
  cause?: unknown,
): ThreadContinueError =>
  new ThreadContinueError({ reason, message, ...(cause !== undefined ? { cause } : {}) });

class TransferGapError extends Error {
  readonly currentSize: number;
  constructor(currentSize: number) {
    super("gap");
    this.currentSize = currentSize;
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

export function makeContinueTransferStore(options: {
  /** Root of the store, e.g. `<baseDir>/tmp/continue`. */
  readonly rootDir: string;
  readonly ttlMs?: number;
  readonly maxBundleBytes?: number;
  readonly chunkBytes?: number;
  readonly now?: () => number;
}): ContinueTransferStoreShape {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxBundleBytes = options.maxBundleBytes ?? THREAD_CONTINUE_MAX_BUNDLE_BYTES;
  const chunkBytes = options.chunkBytes ?? THREAD_CONTINUE_CHUNK_BYTES;
  const now = options.now ?? Date.now;
  const dirs = {
    outgoing: nodePath.join(options.rootDir, "outgoing"),
    incoming: nodePath.join(options.rootDir, "incoming"),
  } as const;

  const pathFor = (side: "outgoing" | "incoming", transferId: string) =>
    TRANSFER_ID_PATTERN.test(transferId)
      ? Effect.succeed(nodePath.join(dirs[side], `${transferId}.bundle`))
      : Effect.fail(fail("invalid_request", "Invalid transfer id."));

  const prepareOutgoing: ContinueTransferStoreShape["prepareOutgoing"] = (transferId) =>
    pathFor("outgoing", transferId).pipe(
      Effect.tap(() =>
        Effect.tryPromise({
          try: () => fsPromises.mkdir(dirs.outgoing, { recursive: true }),
          catch: (cause) =>
            fail("capture_failed", "Could not create the scratch folder for the transfer", cause),
        }),
      ),
    );

  const digest: ContinueTransferStoreShape["digest"] = (side, transferId) =>
    Effect.gen(function* () {
      const filePath = yield* pathFor(side, transferId);
      return yield* Effect.tryPromise({
        try: async () => {
          const stats = await fsPromises.stat(filePath);
          const hash = createHash("sha256");
          await new Promise<void>((resolve, reject) => {
            const stream = createReadStream(filePath);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("error", reject);
            stream.on("end", () => resolve());
          });
          return { sizeBytes: stats.size, sha256: hash.digest("hex") };
        },
        catch: (cause) =>
          isNotFound(cause)
            ? fail(
                "transfer_not_found",
                "The files for this transfer are no longer on this machine. Start again.",
              )
            : fail("transfer_incomplete", "Could not read the transferred files", cause),
      });
    });

  const incomingPath: ContinueTransferStoreShape["incomingPath"] = (transferId) =>
    pathFor("incoming", transferId);

  const readChunk: ContinueTransferStoreShape["readChunk"] = (input) =>
    Effect.gen(function* () {
      const filePath = yield* pathFor("outgoing", input.transferId);
      return yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(filePath, "r");
          try {
            const buffer = Buffer.alloc(chunkBytes);
            const { bytesRead } = await handle.read(
              buffer,
              0,
              chunkBytes,
              input.index * chunkBytes,
            );
            return buffer.subarray(0, bytesRead).toString("base64");
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          isNotFound(cause)
            ? fail(
                "transfer_not_found",
                "The files for this transfer are no longer on the source machine. Start again.",
              )
            : fail("transfer_incomplete", "Could not read the transfer file", cause),
      });
    });

  const writeChunk: ContinueTransferStoreShape["writeChunk"] = (input) =>
    Effect.gen(function* () {
      const filePath = yield* pathFor("incoming", input.transferId);
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length > MAX_WRITE_CHUNK_BYTES) {
        return yield* fail("invalid_request", "Transfer chunk is too large.");
      }
      if (input.offset + bytes.length > maxBundleBytes) {
        return yield* fail(
          "too_large",
          `The files are larger than ${Math.round(maxBundleBytes / (1024 * 1024))} MB, the most one transfer can carry.`,
        );
      }
      return yield* Effect.tryPromise({
        try: async () => {
          await fsPromises.mkdir(dirs.incoming, { recursive: true });
          if (input.offset === 0) {
            await fsPromises.writeFile(filePath, bytes);
            return bytes.length;
          }
          const stats = await fsPromises.stat(filePath).catch((cause: unknown) => {
            if (isNotFound(cause)) return null;
            throw cause;
          });
          const currentSize = stats?.size ?? 0;
          if (currentSize < input.offset) {
            throw new TransferGapError(currentSize);
          }
          const handle = await fsPromises.open(filePath, "r+");
          try {
            if (currentSize > input.offset) {
              await handle.truncate(input.offset);
            }
            await handle.write(bytes, 0, bytes.length, input.offset);
          } finally {
            await handle.close();
          }
          return input.offset + bytes.length;
        },
        catch: (cause) =>
          cause instanceof TransferGapError
            ? fail(
                "transfer_incomplete",
                `Part of the transfer is missing on this machine (have ${cause.currentSize} bytes, next chunk starts at ${input.offset}).`,
              )
            : fail("transfer_incomplete", "Could not write the transferred files", cause),
      });
    });

  const removeIfPresent = (filePath: string) =>
    Effect.promise(() =>
      fsPromises.rm(filePath).then(
        () => true,
        () => false,
      ),
    );

  const discard: ContinueTransferStoreShape["discard"] = (transferId) =>
    TRANSFER_ID_PATTERN.test(transferId)
      ? Effect.all([
          removeIfPresent(nodePath.join(dirs.outgoing, `${transferId}.bundle`)),
          removeIfPresent(nodePath.join(dirs.incoming, `${transferId}.bundle`)),
        ]).pipe(Effect.map(([outgoing, incoming]) => outgoing || incoming))
      : Effect.succeed(false);

  const sweep: ContinueTransferStoreShape["sweep"] = Effect.promise(async () => {
    const cutoff = now() - ttlMs;
    for (const dir of [dirs.outgoing, dirs.incoming]) {
      const entries = await fsPromises.readdir(dir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.endsWith(".bundle")) continue;
        const filePath = nodePath.join(dir, entry);
        const stats = await fsPromises.stat(filePath).catch(() => null);
        if (stats && stats.mtimeMs < cutoff) {
          await fsPromises.rm(filePath).catch(() => undefined);
        }
      }
    }
  });

  return { prepareOutgoing, digest, incomingPath, readChunk, writeChunk, discard, sweep };
}
