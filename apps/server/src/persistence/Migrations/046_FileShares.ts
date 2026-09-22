import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Public share links for the Files app (`/s/<token>`). A row points at one
 * absolute path (a file, or a folder served as a listing/website). The token
 * is stored as is — it only unlocks a file that lives on this same disk, so
 * reading the database already means reading the file — which lets the owner
 * copy a link again later. The password is a salted scrypt hash.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS file_shares (
      share_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      password_hash TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_file_shares_path
    ON file_shares(path)
  `;
});
