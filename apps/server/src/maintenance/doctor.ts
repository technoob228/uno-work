/**
 * `doctor`: looks at a data directory's database and, with `--fix`, compacts it
 * and gives the space back to the disk. Needs Work closed: VACUUM takes the
 * whole file, and with the server running it could not start anyway.
 */
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { statfsSync, statSync } from "node:fs";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PROJECTOR_COUNT } from "./DatabaseCompactor.ts";
import { runCompactionPass } from "./databaseCompaction.ts";

export class DoctorError extends Data.TaggedError("DoctorError")<{ readonly message: string }> {}

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.ceil(bytes / 1024)} KB`;

const readStorage = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const pageSize = size[0]?.page_size ?? 0;
    return {
      bytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incremental: mode[0]?.auto_vacuum === 2,
    };
  });

const printEventBreakdown = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly type: string;
      readonly events: number;
      readonly bytes: number;
    }>`
      SELECT event_type AS type, COUNT(*) AS events, SUM(length(payload_json)) AS bytes
      FROM orchestration_events
      GROUP BY event_type
      ORDER BY bytes DESC
      LIMIT 8
    `;
    for (const row of rows) {
      yield* Console.log(
        `  ${row.type}: ${row.events.toLocaleString("en-US")} events, ${formatBytes(row.bytes)}`,
      );
    }
  });

/**
 * In WAL mode an exclusive lock is refused while any other connection has the
 * file open, even an idle one, which is how a running Work is detected.
 */
const lockExclusively = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`PRAGMA busy_timeout = 0`;
    yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
    yield* sql`BEGIN EXCLUSIVE`;
    yield* sql`COMMIT`;
  }).pipe(
    Effect.mapError(
      () => new DoctorError({ message: "Close Uno Work first: the database is in use." }),
    ),
  );

export const runDoctor = Effect.fn("runDoctor")(function* (
  databasePath: string,
  options: { readonly fix: boolean },
) {
  const fileBytes = yield* Effect.try({
    try: () => statSync(databasePath).size,
    catch: () => new DoctorError({ message: `No database at ${databasePath}.` }),
  });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* readStorage(sql);
    yield* Console.log(
      `Database: ${formatBytes(fileBytes)}, ${formatBytes(before.reclaimableBytes)} free inside.`,
    );
    if (!options.fix) {
      yield* printEventBreakdown(sql);
      yield* Console.log("Nothing changed. Run with --fix to compact, with Work closed.");
      return;
    }
    yield* lockExclusively(sql);
    const state = yield* sql`
      SELECT 1 FROM sqlite_master WHERE name = 'database_compaction_state'
    `;
    if (state.length === 0) {
      return yield* new DoctorError({ message: "Open this version of Uno Work once, then retry." });
    }
    const result = yield* runCompactionPass(sql, {
      now: Date.now(),
      pause: Effect.void,
      projectorCount: PROJECTOR_COUNT,
    });
    yield* Console.log(
      `Folded ${result.foldedMessages} messages, removed ${result.removedMessageEvents + result.removedActivityEvents} old events.`,
    );
    const { bfree, bsize } = statfsSync(databasePath);
    const free = Number(bfree) * Number(bsize);
    const live = before.bytes - before.reclaimableBytes;
    if (free < live * 1.2) {
      yield* Console.log(
        `Compacted, not shrunk: VACUUM needs about ${formatBytes(live * 1.2)} free, there is ${formatBytes(free)}.`,
      );
      return;
    }
    yield* Console.log("Giving space back to the disk. This can take several minutes...");
    // The server keeps temp data in memory; a copy of the whole file belongs on disk.
    yield* sql`PRAGMA temp_store = FILE`;
    // A database made before this needs a VACUUM for the mode to take.
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
    yield* sql`VACUUM`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const after = statSync(databasePath).size;
    yield* Console.log(`Done: ${formatBytes(fileBytes)} -> ${formatBytes(after)}.`);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: !options.fix })),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new DoctorError({ message: `The database refused: ${String(cause)}` })),
    ),
  );
});
