import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * "Don't let agents write here" (0.0.115):
 * `projection_threads.agents_closed_at` — when the person closed the chat to
 * agents; NULL while agents may write into it. Nullable TEXT, guarded so
 * re-running is a no-op. The switch itself is a `thread.meta-updated` event,
 * so a projection rebuild keeps it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "agents_closed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN agents_closed_at TEXT
    `;
  }
});
