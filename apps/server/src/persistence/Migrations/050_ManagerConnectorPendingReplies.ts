import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 050 — replies a Telegram/Slack chat is still owed, on disk.
 *
 * A connector used to watch for the answer to a chat message in an
 * in-memory fiber with a 10-minute deadline: a longer turn got "The
 * assistant is still working on it; check the app for progress." and the
 * real answer never followed; a daemon restart lost the watcher outright.
 *
 * `manager_connector_pending_replies`: one row per chat message that started
 * (or joined) a turn, keyed by the provider's message id. It names the
 * thread, the user message the connector dispatched (the turn is found
 * through it) and where the answer goes (chat, message to reply to, Slack
 * thread). `status` goes `waiting` → `delivered` | `failed`; on start the
 * connector resumes every `waiting` row. `delivered_parts` lets a long
 * answer that was half sent when the daemon died continue where it stopped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connector_pending_replies (
      kind TEXT NOT NULL,
      connector_project_id TEXT NOT NULL,
      reply_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      reply_to TEXT,
      reply_thread TEXT,
      thread_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      turn_id TEXT,
      requested_at TEXT NOT NULL,
      language TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      progress_notes INTEGER NOT NULL DEFAULT 0,
      resume_attempts INTEGER NOT NULL DEFAULT 0,
      delivered_parts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, connector_project_id, reply_key)
    )
  `;

  // The watcher asks "what is still waiting for this kind"; delivered rows
  // never answer that and are pruned after a week.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_connector_pending_replies_status
    ON manager_connector_pending_replies(kind, status, requested_at)
  `;
});
