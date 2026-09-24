import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The assistant as a property of a chat (0.0.83):
 * `projection_threads.assistant_role` — "chat" for THE assistant chat ("Uno",
 * pinned on top of the sidebar), "spawned" for chats the assistant started;
 * NULL for every other chat. Nullable TEXT, guarded so re-running is a no-op.
 *
 * Which existing chat becomes the assistant chat is not decided here: that is
 * an event (`thread.meta-updated`) the assistant bootstrap dispatches, so the
 * event log stays the source of truth and a projection rebuild keeps it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "assistant_role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN assistant_role TEXT
    `;
  }
});
