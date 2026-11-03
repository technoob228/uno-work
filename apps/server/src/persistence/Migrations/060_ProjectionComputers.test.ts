import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ProjectionComputers from "./060_ProjectionComputers.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ProjectionComputers", (it) => {
  it.effect("adds the computer columns once, re-running is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      // Running it again over an already-migrated database must not fail.
      yield* ProjectionComputers;

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(
        projectColumns.filter((column) => column.name === "computer_json").length,
        1,
      );
      assert.strictEqual(
        threadColumns.filter((column) => column.name === "computer_wait_json").length,
        1,
      );
    }),
  );
});
