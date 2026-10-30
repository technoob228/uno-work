/**
 * The message search index: a trigram FTS5 table over finished messages.
 *
 * Trigrams match any substring of three or more characters without a scan,
 * ignoring case, in any language. The table is contentless, so a message's
 * text is not stored twice. Its rowid is `message_search_docs.doc_id`, not the
 * messages table's rowid: that table has no INTEGER PRIMARY KEY, and VACUUM
 * may renumber such rowids, which would silently point hits at other messages.
 *
 * Triggers keep the index right for every write, including revert and delete.
 * Streaming messages stay out until they finish: a delta rewrites the row many
 * times a second. Messages from before the index are added in the background
 * (`backfillMessageSearch`), so startup does not wait for them.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const MESSAGE_SEARCH_TABLE = "message_search";

// `remove_diacritics` in the trigram tokenizer needs 3.45.
const MIN_SQLITE_VERSION = [3, 45] as const;

/** FTS5 with the trigram options, or null: search then scans recent messages. */
export const messageSearchSupported = Effect.fn("MessageSearchIndex.supported")(function* (
  sql: SqlClient.SqlClient,
) {
  const version = yield* sql<{ readonly version: string }>`SELECT sqlite_version() AS version`;
  const [major = 0, minor = 0] = (version[0]?.version ?? "").split(".").map(Number);
  if (
    major < MIN_SQLITE_VERSION[0] ||
    (major === MIN_SQLITE_VERSION[0] && minor < MIN_SQLITE_VERSION[1])
  ) {
    return false;
  }
  const options = yield* sql<{ readonly compile_options: string }>`PRAGMA compile_options`;
  return options.some((option) => option.compile_options === "ENABLE_FTS5");
});

export const messageSearchIndexExists = Effect.fn("MessageSearchIndex.exists")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${MESSAGE_SEARCH_TABLE}
  `;
  return rows.length > 0;
});

/** Guarded, so a migration that runs twice (stage machines) changes nothing. */
export const createMessageSearchIndex = Effect.fn("MessageSearchIndex.create")(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* messageSearchSupported(sql))) {
    yield* Effect.logWarning("Message search index unavailable; search will scan messages.");
    return;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS message_search_docs (
      doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE
    )
  `;
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS message_search_insert
    AFTER INSERT ON projection_thread_messages
    WHEN new.is_streaming = 0 AND new.role IN ('user', 'assistant')
    BEGIN
      INSERT INTO message_search_docs (message_id) VALUES (new.message_id)
      ON CONFLICT (message_id) DO NOTHING;
      INSERT INTO message_search (rowid, text)
      SELECT doc_id, new.text FROM message_search_docs WHERE message_id = new.message_id;
    END
  `;
  // Upserts rewrite every column: a finished message re-indexes only if its text changed.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS message_search_update
    AFTER UPDATE OF text, is_streaming, role ON projection_thread_messages
    WHEN (old.is_streaming = 0 OR new.is_streaming = 0)
      AND (
        old.is_streaming IS NOT new.is_streaming
        OR old.text IS NOT new.text
        OR old.role IS NOT new.role
      )
    BEGIN
      DELETE FROM message_search WHERE rowid = (
        SELECT doc_id FROM message_search_docs WHERE message_id = old.message_id
      );
      DELETE FROM message_search_docs WHERE message_id = old.message_id;
      INSERT INTO message_search_docs (message_id)
      SELECT new.message_id
      WHERE new.is_streaming = 0 AND new.role IN ('user', 'assistant');
      INSERT INTO message_search (rowid, text)
      SELECT doc_id, new.text FROM message_search_docs WHERE message_id = new.message_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS message_search_delete
    AFTER DELETE ON projection_thread_messages
    BEGIN
      DELETE FROM message_search WHERE rowid = (
        SELECT doc_id FROM message_search_docs WHERE message_id = old.message_id
      );
      DELETE FROM message_search_docs WHERE message_id = old.message_id;
    END
  `;
});

const BACKFILL_BATCH_MESSAGES = 200;
const BACKFILL_PAUSE = "25 millis";

/**
 * One step of the backfill: the next messages past `afterRowid` that the index
 * lacks. Returns where to go on from, or null at the end.
 */
export const backfillMessageSearchBatch = Effect.fn("MessageSearchIndex.backfillBatch")(function* (
  sql: SqlClient.SqlClient,
  afterRowid: number,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly rowid: number;
        readonly message_id: string;
        readonly text: string;
        readonly indexable: number;
      }>`
        SELECT
          messages.rowid AS rowid,
          messages.message_id AS message_id,
          messages.text AS text,
          (
            messages.is_streaming = 0
            AND messages.role IN ('user', 'assistant')
            AND docs.doc_id IS NULL
          ) AS indexable
        FROM projection_thread_messages AS messages
        LEFT JOIN message_search_docs AS docs ON docs.message_id = messages.message_id
        WHERE messages.rowid > ${afterRowid}
        ORDER BY messages.rowid ASC
        LIMIT ${BACKFILL_BATCH_MESSAGES}
      `;
      for (const row of rows) {
        if (row.indexable !== 1) continue;
        const doc = yield* sql<{ readonly doc_id: number }>`
          INSERT INTO message_search_docs (message_id) VALUES (${row.message_id})
          RETURNING doc_id
        `;
        const docId = doc[0]?.doc_id;
        if (docId === undefined) continue;
        yield* sql`INSERT INTO message_search (rowid, text) VALUES (${docId}, ${row.text})`;
      }
      return rows.at(-1)?.rowid ?? null;
    }),
  );
});

/** How many finished messages the index does not hold yet. */
export const countUnindexedMessages = Effect.fn("MessageSearchIndex.countUnindexed")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{ readonly missing: number }>`
    SELECT
      (
        SELECT COUNT(*) FROM projection_thread_messages
        WHERE is_streaming = 0 AND role IN ('user', 'assistant')
      ) - (SELECT COUNT(*) FROM message_search_docs) AS missing
  `;
  return Math.max(0, rows[0]?.missing ?? 0);
});

/** Walks the messages table in small transactions, pausing so chats keep flowing. */
export const backfillMessageSearch = Effect.fn("MessageSearchIndex.backfill")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* Effect.logInfo("message search: indexing older messages");
  let cursor: number | null = 0;
  while (cursor !== null) {
    cursor = yield* backfillMessageSearchBatch(sql, cursor);
    yield* Effect.sleep(BACKFILL_PAUSE);
  }
  yield* Effect.logInfo("message search: index ready");
});
