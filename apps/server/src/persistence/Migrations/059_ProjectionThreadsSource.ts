import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `source_json` to `projection_threads`: where a chat came from when it
 * did not start in Uno Work (a program on the person's connected computer,
 * see ThreadSource). Nullable JSON TEXT; guarded so re-running is a no-op.
 *
 * Number 059: it lands on top of the T3 wave, which took 053–058. Re-check
 * before merging.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "source_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN source_json TEXT
    `;
  }
});
