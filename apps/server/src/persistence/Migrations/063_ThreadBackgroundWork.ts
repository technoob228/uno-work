import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `background_work_json` to `projection_threads`: the background agents,
 * commands and monitors a chat's agent left running after its turn (T71,
 * `ThreadBackgroundWork`). Nullable TEXT, NULL for every existing chat.
 * Guarded so re-running is a no-op.
 *
 * Number 063: on top of 062_ThreadPendingForYou. Re-check before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "background_work_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN background_work_json TEXT
    `;
  }
});
