import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ThreadSpawnKind from "./061_ThreadSpawnKind.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_ThreadSpawnKind", (it) => {
  it.effect("adds spawn_kind once, re-running is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* ThreadSpawnKind;

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(threadColumns.filter((column) => column.name === "spawn_kind").length, 1);
    }),
  );
});
