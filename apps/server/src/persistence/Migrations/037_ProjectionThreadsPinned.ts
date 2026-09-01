import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds a `pinned_at` column to `projection_threads` so a user can pin a
 * thread to the top of the sidebar. Null means "not pinned"; a timestamp
 * records when the pin was set. Mirrors the `archived_at` column shape
 * (see 017_ProjectionThreadsArchivedAt) — a nullable ISO-8601 TEXT column,
 * guarded so re-running the migration on an already-migrated database is a
 * no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "pinned_at")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pinned_at TEXT
  `;
});
