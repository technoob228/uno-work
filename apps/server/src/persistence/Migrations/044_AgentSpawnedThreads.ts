import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent-spawned threads (plan 21):
 * - `projection_threads.spawned_by_thread_id` — the thread whose agent created
 *   this one (immutable);
 * - `projection_threads.controller` — "human" | "agent" (NULL reads as human);
 * - `projection_threads.control_changed_at` — last handoff time;
 * - `projection_thread_messages.sent_by_thread_id` — a user-role message
 *   another thread's agent sent.
 * All nullable TEXT; each column is guarded so re-running is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "spawned_by_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN spawned_by_thread_id TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "controller")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN controller TEXT
    `;
  }
  if (!threadColumns.some((column) => column.name === "control_changed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN control_changed_at TEXT
    `;
  }

  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!messageColumns.some((column) => column.name === "sent_by_thread_id")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN sent_by_thread_id TEXT
    `;
  }
});
