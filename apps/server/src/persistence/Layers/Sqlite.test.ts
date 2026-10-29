import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WAL_SIZE_LIMIT_BYTES, makeSqlitePersistenceLive } from "./Sqlite.ts";

const withTempDb = <A, E>(
  prefix: string,
  body: (dbPath: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return body(dbPath).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

// Upstream t3code a74ce48f96, 8aa5be2f02, 0fe4fa40fe.
it.effect("opens the state database with the write-path pragmas", () =>
  withTempDb("uno-sqlite-pragmas-", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = (name: string) => sql.unsafe<Record<string, unknown>>(`PRAGMA ${name}`);
      assert.equal((yield* read("journal_mode"))[0]?.journal_mode, "wal");
      // 1 is NORMAL.
      assert.equal((yield* read("synchronous"))[0]?.synchronous, 1);
      // 2 is MEMORY.
      assert.equal((yield* read("temp_store"))[0]?.temp_store, 2);
      assert.equal((yield* read("busy_timeout"))[0]?.timeout, 5000);
      assert.equal(
        (yield* read("journal_size_limit"))[0]?.journal_size_limit,
        WAL_SIZE_LIMIT_BYTES,
      );
    }),
  ),
);

it.effect("shrinks the WAL file back to the size limit after a large write", () =>
  withTempDb("uno-sqlite-wal-", (dbPath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
      // About 25% more 4 KB rows than the limit holds, in one transaction.
      const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);
      yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
        INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
      `;
      assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

      // The auto-checkpoint after the large commit copied every frame into the
      // database, so the next commit restarts the WAL and cuts the file back.
      yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
      assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
    }),
  ),
);
