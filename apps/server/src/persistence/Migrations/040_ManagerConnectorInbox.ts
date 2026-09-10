/**
 * 038 — durable inbox + health state for assistant connectors.
 *
 * Until now the Telegram poller kept its `getUpdates` offset in memory and
 * advanced it BEFORE an update was handled: a daemon restart re-delivered or
 * lost updates, a crash mid-handling lost the message for good, and nothing
 * recorded whether the connector was healthy at all.
 *
 * - `manager_connector_state`: one row per (assistant, kind) with the
 *   persisted poll offset and the last known health (`status`, `last_ok_at`,
 *   `last_error`, `last_error_at`). The offset only moves once the update it
 *   covers is terminal in the inbox. `credential_fingerprint` ties the offset
 *   to the bot token it was earned with: a new token means a new bot whose
 *   update ids are unrelated, so the cursor restarts from zero.
 * - `manager_connector_inbox`: one row per provider event. Insert is
 *   idempotent on (project_id, kind, provider_event_id), so a re-delivered
 *   update is recognised and skipped; rows still `received` after a restart
 *   are re-processed from their stored payload (bounded by `attempts`).
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connector_state (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      poll_offset INTEGER NOT NULL DEFAULT 0,
      credential_fingerprint TEXT,
      status TEXT,
      last_ok_at TEXT,
      last_error TEXT,
      last_error_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, kind)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connector_inbox (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      handled_at TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY (project_id, kind, provider_event_id)
    )
  `;

  // Restart recovery asks "what is still unhandled for this connector,
  // oldest first"; handled rows never answer that.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_connector_inbox_pending
    ON manager_connector_inbox(project_id, kind, received_at)
    WHERE status = 'received'
  `;
});
