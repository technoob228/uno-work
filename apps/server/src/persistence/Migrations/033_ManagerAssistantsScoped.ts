import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Scope assistant connectors (and their chat→thread mappings) by assistant
 * project id: every assistant gets its own Telegram bot and allowlist.
 * Pre-existing single-connector rows migrate to the default `assistant-home`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_assistant_connectors (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, kind)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_assistant_connector_threads (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, kind, chat_id)
    )
  `;

  const legacyConnectors = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_connectors'
  `;
  if (legacyConnectors.length > 0) {
    yield* sql`
      INSERT OR IGNORE INTO manager_assistant_connectors (project_id, kind, config_json, updated_at)
      SELECT 'assistant-home', kind, config_json, updated_at FROM manager_connectors
    `;
    yield* sql`DROP TABLE manager_connectors`;
  }

  const legacyThreads = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_connector_threads'
  `;
  if (legacyThreads.length > 0) {
    yield* sql`
      INSERT OR IGNORE INTO manager_assistant_connector_threads (project_id, kind, chat_id, thread_id, created_at)
      SELECT 'assistant-home', connector_kind, chat_id, thread_id, created_at FROM manager_connector_threads
    `;
    yield* sql`DROP TABLE manager_connector_threads`;
  }
});
