import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Share links get a level, like Google Docs: `view` (default, what every
 * existing link already did), `comment` or `edit` — the last two only for
 * Word/Excel/PowerPoint files, which open in the in-browser editor at
 * `/s/<token>` and save back into that one file.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(file_shares)`;
  if (columns.some((column) => column.name === "access")) return;
  yield* sql`ALTER TABLE file_shares ADD COLUMN access TEXT NOT NULL DEFAULT 'view'`;
});
