import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `pending_for_you_json` to `projection_threads`: what in the chat still
 * waits for the person — unanswered cards, unopened site links, what they
 * hid (T52, `@t3tools/shared/pendingForYou`). Nullable TEXT, NULL for every
 * existing chat: it starts tracking on its next event, so old cards don't
 * light up. Guarded so re-running is a no-op.
 *
 * Number 062: on top of 061_ThreadSpawnKind. Re-check before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pending_for_you_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_for_you_json TEXT
    `;
  }
});
