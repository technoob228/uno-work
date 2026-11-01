/**
 * OpenCode keeps everything in one SQLite file, logins included (`credential`,
 * `account`), so the file never leaves the computer: the import runs fixed
 * SELECTs through `sqlite3` or `opencode db` on the computer itself, against
 * named columns of `session`, `message` and `part`, and nothing else.
 *
 * Without either command OpenCode counts as unavailable, honestly. The same
 * goes for a schema this version doesn't know (the dev branch has `session_v2`)
 * and for versions before 1.2 (JSON files in `storage/`).
 *
 * @module myComputer/import/openCodeSessions
 */
import type { ComputerOs } from "./chatPaths.ts";
import {
  asRecord,
  asString,
  cleanTitle,
  isoDate,
  type ChatSummary,
  type HistoryMessage,
} from "./sessionText.ts";

export type SqlRow = Readonly<Record<string, unknown>>;
/** Runs one fixed SELECT on the computer. */
export type SqlRunner = (sql: string) => Promise<ReadonlyArray<SqlRow>>;

export const OPENCODE_PAGE_ROWS = 400;
const HISTORY_PAGE_ROWS = 200;
const HISTORY_MAX_MESSAGES = 1000;

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** Single quotes survive POSIX shells and PowerShell, each with its own escape. */
export function shellQuote(os: ComputerOs, value: string): string {
  if (os === "windows") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sqlite3Command(os: ComputerOs, dbPath: string, sql: string): string {
  return `sqlite3 -readonly -json ${shellQuote(os, dbPath)} ${shellQuote(os, sql)}`;
}

export function openCodeDbCommand(os: ComputerOs, sql: string): string {
  return `opencode db ${shellQuote(os, sql)} --format json`;
}

/** `sqlite3 -json` prints nothing at all for no rows. */
export function parseSqlOutput(output: string): ReadonlyArray<SqlRow> | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((row: unknown): Array<SqlRow> => {
      const record = asRecord(row);
      return record === null ? [] : [record];
    });
  } catch {
    return null;
  }
}

const SESSION_COLUMNS = ["id", "directory", "title", "time_created", "time_updated"];
const MESSAGE_COLUMNS = ["id", "session_id", "time_created", "data"];
const PART_COLUMNS = ["message_id", "session_id", "time_created", "data"];

export interface OpenCodeSchema {
  readonly hasParentId: boolean;
  readonly hasArchived: boolean;
}

/** Null: not a schema this version can read. */
export async function readOpenCodeSchema(run: SqlRunner): Promise<OpenCodeSchema | null> {
  const columnsOf = async (table: string) =>
    new Set(
      (await run(`SELECT name FROM pragma_table_info('${table}')`)).map((row) =>
        asString(row["name"]),
      ),
    );
  const session = await columnsOf("session");
  const message = await columnsOf("message");
  const part = await columnsOf("part");
  const holds = (found: Set<string | null>, wanted: ReadonlyArray<string>) =>
    wanted.every((column) => found.has(column));
  if (
    !holds(session, SESSION_COLUMNS) ||
    !holds(message, MESSAGE_COLUMNS) ||
    !holds(part, PART_COLUMNS)
  ) {
    return null;
  }
  return { hasParentId: session.has("parent_id"), hasArchived: session.has("time_archived") };
}

/** One page of the chats a person would see: no sub-agent sessions, no archived ones. */
export function sessionsPageSql(schema: OpenCodeSchema, offset: number): string {
  const conditions = [
    ...(schema.hasParentId ? ["parent_id IS NULL"] : []),
    ...(schema.hasArchived ? ["time_archived IS NULL"] : []),
  ];
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT id, directory, title, time_created, time_updated FROM session${where} ORDER BY time_updated DESC, id LIMIT ${OPENCODE_PAGE_ROWS} OFFSET ${offset}`;
}

/** OpenCode's placeholder until it names a session. */
const DEFAULT_TITLE = /^(?:new session|child session)\s*-/i;

export interface OpenCodeChat extends ChatSummary {
  readonly sessionId: string;
  readonly fingerprint: string;
}

/** Null: the row isn't a session this version can name. */
export function parseSessionRow(row: SqlRow): OpenCodeChat | null {
  const sessionId = asString(row["id"]);
  if (sessionId === null || !SESSION_ID.test(sessionId)) return null;
  const startedAt = isoDate(row["time_created"]);
  const lastActiveAt = isoDate(row["time_updated"]);
  if (startedAt === null || lastActiveAt === null) return null;
  const title = asString(row["title"]);
  return {
    sessionId,
    title: title === null || DEFAULT_TITLE.test(title) ? null : cleanTitle(title),
    cwd: asString(row["directory"]),
    startedAt,
    lastActiveAt,
    fingerprint: `${String(row["time_updated"])}`,
  };
}

/** When the session last changed, or null when it is gone. */
export async function openCodeFingerprint(
  run: SqlRunner,
  sessionId: string,
): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const rows = await run(`SELECT time_updated FROM session WHERE id='${sessionId}'`);
  const updated = rows[0]?.["time_updated"];
  return updated === undefined || updated === null ? null : String(updated);
}

/**
 * The last messages and the text of their parts, paged so one long chat never
 * overruns a command's output. Tool output stays on the computer: only parts of
 * type `text` are selected.
 */
export async function readOpenCodeHistory(
  run: SqlRunner,
  sessionId: string,
): Promise<{ readonly messages: Array<HistoryMessage>; readonly truncated: boolean }> {
  if (!SESSION_ID.test(sessionId)) return { messages: [], truncated: false };
  const messageRows: Array<SqlRow> = [];
  for (let offset = 0; offset < HISTORY_MAX_MESSAGES; offset += HISTORY_PAGE_ROWS) {
    const page = await run(
      `SELECT id, time_created, json_extract(data, '$.role') AS role FROM message WHERE session_id='${sessionId}' ORDER BY time_created DESC, id DESC LIMIT ${HISTORY_PAGE_ROWS} OFFSET ${offset}`,
    );
    messageRows.push(...page);
    if (page.length < HISTORY_PAGE_ROWS) break;
  }
  const truncated = messageRows.length >= HISTORY_MAX_MESSAGES;
  if (messageRows.length === 0) return { messages: [], truncated };
  const oldest = messageRows.at(-1)?.["time_created"];
  const since = typeof oldest === "number" ? oldest : 0;

  const textByMessage = new Map<string, Array<string>>();
  for (let offset = 0; ; offset += HISTORY_PAGE_ROWS) {
    const page = await run(
      `SELECT message_id, json_extract(data, '$.text') AS text FROM part WHERE session_id='${sessionId}' AND time_created >= ${since} AND json_extract(data, '$.type') = 'text' ORDER BY time_created, id LIMIT ${HISTORY_PAGE_ROWS} OFFSET ${offset}`,
    );
    for (const row of page) {
      const messageId = asString(row["message_id"]);
      const text = asString(row["text"]);
      if (messageId === null || text === null) continue;
      const pieces = textByMessage.get(messageId) ?? [];
      pieces.push(text);
      textByMessage.set(messageId, pieces);
    }
    if (page.length < HISTORY_PAGE_ROWS) break;
  }

  const messages = messageRows.toReversed().flatMap((row): Array<HistoryMessage> => {
    const id = asString(row["id"]);
    const role = row["role"];
    const createdAt = isoDate(row["time_created"]);
    if (id === null || createdAt === null || (role !== "user" && role !== "assistant")) return [];
    const text = (textByMessage.get(id) ?? []).join("\n\n").trim();
    return text.length > 0 ? [{ id, role, text, createdAt }] : [];
  });
  return { messages, truncated };
}
