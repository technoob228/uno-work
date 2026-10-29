import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `last_visited_at` to `projection_threads`: the read watermark of a chat
 * (thread.visit / thread.mark-unread), shared by web Work and the T3 phone
 * app. Until now read state lived only in the browser (useUiStateStore). The
 * column is nullable ISO-8601 TEXT; guarded so re-running is a no-op.
 *
 * Number 052: 051 is taken by feat/sidebar-project-icons-owner-1028
 * (051_ThreadOwner). Re-check before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "last_visited_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_visited_at TEXT
    `;
  }
});
