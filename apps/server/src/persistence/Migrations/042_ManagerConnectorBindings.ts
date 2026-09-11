/**
 * 042 — chat → target bindings for assistant connectors (ADR 2026-09-11).
 *
 * A connector chat used to be hard-wired to the assistant project that owns
 * the bot. This table lets the owner (or the chat itself, via `/use`,
 * `/thread`, `/assistant`) point a chat at a regular project or at one
 * specific thread instead. No row = bound to the connector's assistant, so
 * existing chats keep their behaviour.
 *
 * `notify_on_complete` opts the chat into "turn completed" pushes from the
 * events forwarder; errors and approval requests are pushed regardless.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connector_bindings (
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      connector_project_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('assistant', 'project', 'thread')),
      target_id TEXT NOT NULL,
      notify_on_complete INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, chat_id)
    )
  `;

  // The notify path asks "which chats are bound to this thread / project".
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_connector_bindings_target
    ON manager_connector_bindings(target_kind, target_id)
  `;
});
