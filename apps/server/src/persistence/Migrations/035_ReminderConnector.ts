import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Reminders can now be delivered through Slack too; rows predating the column
// are Telegram reminders.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE reminders ADD COLUMN connector TEXT NOT NULL DEFAULT 'telegram'
  `;
});
