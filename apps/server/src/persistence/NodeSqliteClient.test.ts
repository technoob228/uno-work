import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Scheduler } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );
});

layer("NodeSqliteClient large bindings", (it) => {
  it("flags only executions binding more than LARGE_BINDING_SIZE", () => {
    const big = "x".repeat(SqliteClient.LARGE_BINDING_SIZE + 1);
    assert.equal(SqliteClient.hasLargeBinding(["small", 1, null]), false);
    assert.equal(SqliteClient.hasLargeBinding([big]), true);
    assert.equal(
      SqliteClient.hasLargeBinding([new Uint8Array(SqliteClient.LARGE_BINDING_SIZE + 1)]),
      true,
    );
    assert.equal(SqliteClient.hasLargeBinding([{ payload: big }]), true);
    const withGetter = Object.defineProperty({}, "payload", {
      enumerable: true,
      get: () => "small",
    });
    assert.equal(SqliteClient.hasLargeBinding([withGetter]), true);
  });

  it.effect("round-trips a large payload through a throwaway statement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const big = "y".repeat(SqliteClient.LARGE_BINDING_SIZE * 2);
      yield* sql`CREATE TABLE blobs(id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
      yield* sql`INSERT INTO blobs(body) VALUES (${big})`;
      yield* sql`INSERT INTO blobs(body) VALUES (${"small"})`;
      const rows = yield* sql<{ readonly len: number }>`
        SELECT length(body) AS len FROM blobs ORDER BY id
      `;
      assert.deepEqual(
        rows.map((row) => row.len),
        [SqliteClient.LARGE_BINDING_SIZE * 2, 5],
      );
    }),
  );
});

layer("NodeSqliteClient interrupted statements", (it) => {
  // 11.11, box 395: every database call hung for 3 h while HTTP kept
  // answering. An interrupted query must leave nothing behind: with
  // effect/Semaphore the connection's permit stayed taken (every later query
  // waited forever), with effect/Cache the statement's slot kept the
  // interruption (every later use of that SQL failed for 10 minutes). The
  // scheduler budget walks the interruption across every step of a first use
  // (a budget of 1 never makes progress: each run yields before its first step).
  it.effect(
    "an interrupted query never wedges the database or its statement for later callers",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const wedged: Array<string> = [];
          for (let budget = 2; budget <= 60; budget += 1) {
            for (let parentYields = 0; parentYields <= 2; parentYields += 1) {
              const text = `SELECT ${budget * 10 + parentYields} AS n`;
              const first = yield* Effect.forkChild(
                sql.unsafe(text).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
              );
              for (let index = 0; index < parentYields; index += 1) {
                yield* Effect.yieldNow;
              }
              yield* Fiber.interrupt(first);
              const again = yield* sql.unsafe(text).pipe(Effect.timeoutOption("200 millis"));
              if (Option.isNone(again)) wedged.push(text);
            }
          }
          assert.deepEqual(wedged, []);
        }),
      ),
  );
});

layer("NodeSqliteClient connection lock", (it) => {
  it.effect("a statement waits for another fiber's transaction instead of joining it", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE lock_rows(v INTEGER)`;
        const gate = yield* Deferred.make<void>();
        const transaction = yield* Effect.forkChild(
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO lock_rows VALUES (1)`;
                yield* Deferred.await(gate);
                return yield* Effect.fail("roll back");
              }),
            )
            .pipe(Effect.ignore),
        );
        yield* Effect.sleep("20 millis");
        const reader = yield* Effect.forkChild(
          sql<{ readonly c: number }>`SELECT count(*) AS c FROM lock_rows`,
        );
        yield* Effect.sleep("20 millis");
        assert.equal(reader.pollUnsafe(), undefined);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(transaction);
        const rows = yield* Fiber.join(reader);
        assert.equal(rows[0]?.c, 0);
      }),
    ),
  );
});

layer("NodeSqliteClient statement cache", (it) => {
  it("keeps recent statements, drops the least recently used and expired ones", () => {
    let now = 0;
    let prepared = 0;
    const prepare = (sql: string) => {
      prepared += 1;
      return { sql, id: prepared };
    };
    const cache = new SqliteClient.StatementCache<{ sql: string; id: number }>(2, 1_000, () => now);
    const a = cache.get("a", prepare);
    assert.equal(cache.get("a", prepare), a);
    cache.get("b", prepare);
    cache.get("a", prepare); // "a" is now the most recent
    cache.get("c", prepare); // evicts "b"
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a", prepare), a);
    assert.equal(prepared, 3);
    cache.get("b", prepare);
    assert.equal(prepared, 4);
    now = 1_000;
    assert.notEqual(cache.get("a", prepare), a);
  });

  it("does not keep a statement that failed to prepare", () => {
    const cache = new SqliteClient.StatementCache<string>(10, 60_000);
    let fail = true;
    const prepare = (sql: string) => {
      if (fail) throw new Error("SQLITE_BUSY");
      return sql;
    };
    assert.throws(() => cache.get("x", prepare), /SQLITE_BUSY/);
    assert.equal(cache.size, 0);
    fail = false;
    assert.equal(cache.get("x", prepare), "x");
  });
});
