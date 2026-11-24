import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `handler_json` to `projection_threads`: who handles a chat the person
 * handed off ("Hand to…", T63) — another chat or an assistant's conversation
 * (`ThreadHandler`). Nullable TEXT, NULL for every existing chat: nobody
 * handles it, the person does. Guarded so re-running is a no-op.
 *
 * Number 064: 062 is T52 (pending for you), 063 is T71 (background work).
 * Re-check before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "handler_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN handler_json TEXT
    `;
  }
});
