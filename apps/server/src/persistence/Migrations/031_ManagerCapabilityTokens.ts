import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_capability_tokens (
      token_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      project_allowlist_json TEXT NOT NULL,
      budget_json TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_capability_tokens_active
    ON manager_capability_tokens(revoked_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_action_proposals (
      proposal_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      action_json TEXT NOT NULL,
      status TEXT NOT NULL,
      nonce TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_command_ids_json TEXT NOT NULL DEFAULT '[]'
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_action_proposals_status
    ON manager_action_proposals(status, expires_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_manager_action_proposals_token_window
    ON manager_action_proposals(token_id, requested_at)
  `;
});
