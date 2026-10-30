import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Dev mode's PR link (GIT_SYNC_V1, stage 4): `pull_requests_json` holds the
 * thread's pull requests with the host's last answer, `auto_settle_disabled_at`
 * the person's "don't settle this thread when its PR merges". The partial index
 * serves the sweep, which runs every minute for a person in Dev mode. Guarded
 * so re-running is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pull_requests_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pull_requests_json TEXT
    `;
  }
  if (!columns.some((column) => column.name === "auto_settle_disabled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN auto_settle_disabled_at TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_pull_request_sweep
    ON projection_threads (project_id)
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
      AND (branch IS NOT NULL OR pull_requests_json IS NOT NULL)
  `;
});
