import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tokenColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(manager_capability_tokens)
  `;
  if (!tokenColumns.some((column) => column.name === "auto_approve")) {
    yield* sql`
      ALTER TABLE manager_capability_tokens
      ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connectors (
      kind TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manager_connector_threads (
      connector_kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (connector_kind, chat_id)
    )
  `;
});
