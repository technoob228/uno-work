import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
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
