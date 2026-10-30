import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A chat stopped at the limit of the person's own AI plan waits here for the
 * reset (planResume/). The row is the source of truth, so the wait survives a
 * restart of the daemon and a sleeping computer: an overdue row fires on the
 * first sweep after it is back. One row per stopped request, whatever became
 * of it: that is what makes "one automatic try per case" hold.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS plan_resumes (
      resume_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      stopped_turn_id TEXT,
      last_user_message_id TEXT,
      resume_at TEXT NOT NULL,
      status TEXT NOT NULL,
      end_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_resumes_due
    ON plan_resumes(status, resume_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_resumes_thread_pending
    ON plan_resumes(thread_id)
    WHERE status = 'pending'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plan_resumes_thread_case
    ON plan_resumes(thread_id, last_user_message_id)
  `;
});
