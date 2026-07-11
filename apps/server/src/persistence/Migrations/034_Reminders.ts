import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      delivered_at TEXT,
      failure_reason TEXT
    )
  `;

  // The scheduler sweep selects pending rows whose due_at has passed.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders(status, due_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_reminders_project
    ON reminders(project_id)
  `;
});
