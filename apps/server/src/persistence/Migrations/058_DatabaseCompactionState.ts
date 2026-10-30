import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** How far compaction has gone (maintenance/databaseCompaction.ts), so it resumes there. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS database_compaction_state (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `;
});
