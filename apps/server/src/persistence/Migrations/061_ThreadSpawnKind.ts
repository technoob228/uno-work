import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `spawn_kind` to `projection_threads`: what a chat another chat's agent
 * started is for — `subagent` (a short helper) or `thread` (a long work chat
 * the person may join), see ThreadSpawnKind. Nullable TEXT, NULL for every
 * existing chat (read as a thread); guarded so re-running is a no-op.
 *
 * Number 061: on top of 060_ProjectionComputers. Re-check before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "spawn_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN spawn_kind TEXT
    `;
  }
});
