import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `snoozed_until` / `snoozed_at` to `projection_threads` so a thread can
 * be snoozed out of the sidebar inbox until a wake time. Ported from upstream
 * T3 Code's 034_ProjectionThreadsSnoozed (our numbering continues after 042).
 * Both columns are nullable ISO-8601 TEXT; each is guarded so re-running the
 * migration on an already-migrated database is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "snoozed_until")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_until TEXT
    `;
  }

  if (!columns.some((column) => column.name === "snoozed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN snoozed_at TEXT
    `;
  }
});
