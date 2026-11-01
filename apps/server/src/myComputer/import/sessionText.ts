/**
 * What the three session formats share: reading the start and the end of a
 * file that may be huge, pulling a field out of a line cut in half, and turning
 * a first message into a chat title.
 *
 * Nothing here logs: session text is the person's.
 *
 * @module myComputer/import/sessionText
 */
import type { ImportedChatTool } from "@t3tools/contracts";

/** Enough for the first prompt and the session's metadata. */
export const PEEK_HEAD_BYTES = 64 * 1024;
/** Enough for the latest title and the last line. */
export const PEEK_TAIL_BYTES = 32 * 1024;

const TITLE_MAX_CHARS = 120;

/** The start and, for a big file, the end of a session. */
export interface SessionPeek {
  readonly head: string;
  /** Null when `head` already holds the whole file. */
  readonly tail: string | null;
  /** The head stops mid-file: its last line is cut. */
  readonly headCut: boolean;
}

export interface ChatSummary {
  /** Null when nothing in the session can name it; see `fallbackTitle`. */
  readonly title: string | null;
  readonly cwd: string | null;
  readonly startedAt: string | null;
  readonly lastActiveAt: string | null;
}

export type PeekResult =
  | ({ readonly kind: "chat" } & ChatSummary)
  /** Fine, but not a chat: a sub-agent's session, an empty one. */
  | { readonly kind: "not-a-chat" }
  /** Nothing readable in it. */
  | { readonly kind: "broken" }
  /** Readable, but not a format this version knows. */
  | { readonly kind: "unknown-format" };

export interface HistoryMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function parseLine(line: string): Readonly<Record<string, unknown>> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Complete JSON lines of a whole file, in order; a broken line is skipped. */
export function parseJsonLines(text: string): Array<Readonly<Record<string, unknown>>> {
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  for (const line of text.split("\n")) {
    const row = parseLine(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Complete JSON lines of the head: the last one is cut when the file goes on. */
export function headRows(peek: SessionPeek): Array<Readonly<Record<string, unknown>>> {
  const lines = peek.head.split("\n");
  if (peek.headCut) lines.pop();
  return lines.map(parseLine).filter((row) => row !== null);
}

/** Complete JSON lines of the tail: the first one starts mid-line. */
export function tailRows(peek: SessionPeek): Array<Readonly<Record<string, unknown>>> {
  if (peek.tail === null) return [];
  return peek.tail
    .split("\n")
    .slice(1)
    .map(parseLine)
    .filter((row) => row !== null);
}

function unescapeJson(raw: string): string {
  // A cut escape at the very end of a partial string would fail the parse.
  const safe = raw.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try {
    return JSON.parse(`"${safe}"`) as string;
  } catch {
    return safe;
  }
}

/**
 * The first string value of `key` in raw JSON text, even inside a line cut in
 * half or a line too long to fit the head: a 200 KB pasted prompt still names
 * the chat. A value that runs off the end comes back as far as it got.
 */
export function extractJsonString(text: string, key: string): string | null {
  const needle = `"${key}":"`;
  const start = text.indexOf(needle);
  if (start === -1) return null;
  const from = start + needle.length;
  let index = from;
  while (index < text.length) {
    const char = text.charCodeAt(index);
    if (char === 92 /* \ */) {
      index += 2;
      continue;
    }
    if (char === 34 /* " */) break;
    index += 1;
  }
  return unescapeJson(text.slice(from, Math.min(index, text.length))) || null;
}

/** One line of plain text, short enough for a chat list. Null when nothing is left. */
export function cleanTitle(text: string | null | undefined): string | null {
  if (text == null) return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length <= TITLE_MAX_CHARS
    ? line
    : `${line.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

const TOOL_NAMES: Readonly<Record<ImportedChatTool, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const toolName = (tool: ImportedChatTool): string => TOOL_NAMES[tool];

/** A session that never said anything usable about itself still needs a name. */
export function fallbackTitle(tool: ImportedChatTool, lastActiveAt: string): string {
  return `${toolName(tool)} chat, ${lastActiveAt.slice(0, 10)}`;
}

/** A valid ISO date or null: a chat's dates come from files anyone could edit. */
export function isoDate(value: unknown): string | null {
  const parsed =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string" && value.length > 0
        ? new Date(value)
        : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
