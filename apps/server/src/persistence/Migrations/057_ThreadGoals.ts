import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `/goal` (goal/): a row per goal, the source of truth for how far it got, so
 * a restart cannot reset its ceilings. One active goal per chat.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_goals (
      goal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      nonce TEXT NOT NULL,
      status TEXT NOT NULL,
      turns_used INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      cost_usd REAL,
      last_reported_cost_usd REAL,
      max_cost_usd REAL NOT NULL,
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      last_turn_id TEXT,
      end_note TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_goals_active
    ON thread_goals(thread_id)
    WHERE status = 'active'
  `;
});
