import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `settled_override` ("settled" | "active" | NULL) and `settled_at` to
 * `projection_threads` for the manual settle lifecycle (thread.settle /
 * thread.unsettle). Ported from upstream T3 Code's 033_ProjectionThreadsSettled
 * (our numbering continues after 044). Both columns are nullable TEXT; each is
 * guarded so re-running the migration on a migrated database is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }

  if (!columns.some((column) => column.name === "settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }
});
