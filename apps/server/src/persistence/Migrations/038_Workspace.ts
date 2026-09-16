/**
 * 038 — the workspace registry: machines, grants, claims, requests, instructions.
 *
 * The sidebar could already union several environments, but nothing on disk
 * said those environments *belong together*, so every cross-machine question
 * ("who holds this repository", "may HK write here", "what did we agree the
 * agents should know") had no place to live.
 *
 * Single-row `workspace_identity` rather than a table of workspaces: a daemon
 * participates in exactly one workspace. Two would mean two answers to "who is
 * my registry", and the failure mode of guessing wrong is silently writing to
 * someone else's machine.
 *
 * `epoch` is bumped by every mutation. It is the difference between "your view
 * is stale" and "nothing has changed", which the panel has to state out loud —
 * on silent staleness we have been burned before with tunnels.
 *
 * **Frozen.** `workspace_grants`, `workspace_claims`, `workspace_requests`,
 * `workspace_activity` and `workspace_identity.policy_json` are no longer read
 * or written: the commands that filled them ran without any permission check
 * and nothing ever enforced the rows. The tables stay so an older daemon can
 * still open the database; a later migration drops them. Do not add new
 * readers — cross-machine permissions will come from the Uno account.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0,
      registry_environment_id TEXT,
      uno_account_id INTEGER,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_machines (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      monogram TEXT NOT NULL,
      color_slot INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      uno_box_id INTEGER,
      scope TEXT NOT NULL DEFAULT 'full',
      repositories_json TEXT NOT NULL DEFAULT '[]',
      added_at TEXT NOT NULL,
      last_seen_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_grants (
      grant_id TEXT PRIMARY KEY,
      from_environment_id TEXT NOT NULL,
      to_environment_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      transport TEXT NOT NULL DEFAULT 'direct',
      mode TEXT NOT NULL DEFAULT 'request',
      requires_claim INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  // One holder per key, enforced by the schema rather than by a read-then-write
  // in application code: two machines racing for the same claim is the normal
  // case, not the exceptional one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_claims (
      claim_id TEXT PRIMARY KEY,
      claim_key TEXT NOT NULL UNIQUE,
      holder_environment_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      from_environment_id TEXT NOT NULL,
      to_environment_id TEXT NOT NULL,
      repository_key TEXT NOT NULL DEFAULT '*',
      thread_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      payload_preview TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      nonce TEXT NOT NULL,
      hops INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workspace_requests_pending
    ON workspace_requests(status, expires_at)
  `;

  // `environment_id = '*'` is the workspace-wide layer; a concrete id is that
  // machine's override.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_instructions (
      environment_id TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `;

  // Append-only ledger behind the "7 / 20 per hour" budget. Kept separate from
  // the orchestration event store because it must survive thread deletion: the
  // budget protects the machine, not the conversation.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      from_environment_id TEXT NOT NULL,
      kind TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workspace_activity_occurred_at
    ON workspace_activity(occurred_at)
  `;
});
