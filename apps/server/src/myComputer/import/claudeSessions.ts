/**
 * Claude Code sessions: `<config>/projects/<folder>/<session uuid>.jsonl`.
 * Taken from real sessions of 2.1.316 and the Agent SDK's own reader (see the
 * M3 section in knowledge/connect-my-computer-plan-2026-10-31.md).
 *
 * A file holds much more than the conversation: request blobs, queue and cost
 * records. Lines without a `type` of user or assistant are never shown.
 *
 * @module myComputer/import/claudeSessions
 */
import {
  asRecord,
  asString,
  cleanTitle,
  extractJsonString,
  headRows,
  isoDate,
  parseJsonLines,
  tailRows,
  type HistoryMessage,
  type PeekResult,
  type SessionPeek,
} from "./sessionText.ts";

type Row = Readonly<Record<string, unknown>>;

/** Text Claude Code itself put into a user turn: reminders, interrupts, command output. */
const INJECTED_TEXT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const BASH_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/;

/** The person's words in a user turn; null for a tool result or injected text. */
function userText(row: Row): string | null {
  if (row["type"] !== "user" || row["isMeta"] === true || row["isCompactSummary"] === true) {
    return null;
  }
  const content = asRecord(row["message"])?.["content"];
  const texts: Array<string> = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const entry = asRecord(block);
      // A turn with a tool result is the tool answering, whatever else it holds.
      if (entry?.["type"] === "tool_result") return null;
      if (entry?.["type"] === "text" && typeof entry["text"] === "string")
        texts.push(entry["text"]);
    }
  }
  for (const text of texts) {
    const trimmed = text.trim();
    const bash = BASH_INPUT.exec(trimmed);
    if (bash?.[1] !== undefined) return `! ${bash[1].trim()}`;
    const command = COMMAND_NAME.exec(trimmed);
    if (command?.[1] !== undefined) return command[1];
    if (trimmed.length > 0 && !INJECTED_TEXT.test(trimmed)) return trimmed;
  }
  return null;
}

function assistantText(row: Row): string | null {
  const content = asRecord(row["message"])?.["content"];
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      const entry = asRecord(block);
      return entry?.["type"] === "text" ? (asString(entry["text"]) ?? "") : "";
    })
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/** Newest wins: a person's rename, then Claude's own title, then the compact summary. */
function explicitTitle(rows: ReadonlyArray<Row>): string | null {
  let custom: string | null = null;
  let ai: string | null = null;
  let summary: string | null = null;
  for (const row of rows) {
    custom = asString(row["customTitle"]) ?? custom;
    ai = asString(row["aiTitle"]) ?? ai;
    if (row["type"] === "summary") summary = asString(row["summary"]) ?? summary;
  }
  return custom ?? ai ?? summary;
}

const isKnownRow = (row: Row) =>
  typeof row["type"] === "string" && (typeof row["sessionId"] === "string" || "uuid" in row);

export function peekClaudeSession(peek: SessionPeek): PeekResult {
  const head = headRows(peek);
  const tail = tailRows(peek);
  const rows = [...head, ...tail];
  // A first line longer than the head leaves no complete row: go by raw text.
  if (head.length === 0) {
    const sessionId = extractJsonString(peek.head, "sessionId");
    if (sessionId === null) return { kind: "broken" };
  } else if (!head.some(isKnownRow)) {
    return { kind: "unknown-format" };
  }
  if (head[0]?.["isSidechain"] === true) return { kind: "not-a-chat" };

  const firstPrompt = head.map(userText).find((text) => text !== null) ?? null;
  const rawPrompt =
    firstPrompt === null && peek.headCut ? extractJsonString(peek.head, "content") : null;
  const lastPrompt = rows
    .map((row) => asString(row["lastPrompt"]))
    .findLast((text) => text !== null);
  const hasTurn = firstPrompt !== null || rawPrompt !== null || lastPrompt != null;
  if (!hasTurn && !rows.some((row) => row["type"] === "assistant")) {
    return { kind: "not-a-chat" };
  }

  const timestamps = rows.map((row) => isoDate(row["timestamp"])).filter((at) => at !== null);
  return {
    kind: "chat",
    title: cleanTitle(explicitTitle(rows)) ?? cleanTitle(firstPrompt ?? rawPrompt ?? lastPrompt),
    cwd:
      rows.map((row) => asString(row["cwd"])).find((cwd) => cwd !== null) ??
      extractJsonString(peek.head, "cwd"),
    startedAt: timestamps[0] ?? isoDate(extractJsonString(peek.head, "timestamp")),
    lastActiveAt: timestamps.at(-1) ?? null,
  };
}

/**
 * The branch the person ended on. A file keeps every branch of a rewound chat,
 * so reading it top to bottom would show dead ends: walk back from the last
 * turn. A compaction starts a new root that names the old one in
 * `logicalParentUuid`. A chain that does not hold together (an old format, the
 * tail of a huge file) falls back to file order.
 */
function currentBranch(rows: ReadonlyArray<Row>): ReadonlyArray<Row> {
  const byUuid = new Map<string, Row>();
  let leaf: Row | null = null;
  for (const row of rows) {
    const uuid = asString(row["uuid"]);
    if (uuid !== null) byUuid.set(uuid, row);
    if ((row["type"] === "user" || row["type"] === "assistant") && row["isSidechain"] !== true) {
      leaf = row;
    }
  }
  const linear = () =>
    rows.filter(
      (row) =>
        (row["type"] === "user" || row["type"] === "assistant") && row["isSidechain"] !== true,
    );
  if (leaf === null) return [];
  const chain: Array<Row> = [];
  const seen = new Set<Row>();
  let current: Row | undefined = leaf;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const parent: string | null =
      asString(current["parentUuid"]) ?? asString(current["logicalParentUuid"]);
    if (parent === null) break;
    const next = byUuid.get(parent);
    if (next === undefined) return linear();
    current = next;
  }
  return chain.reverse().filter((row) => row["type"] === "user" || row["type"] === "assistant");
}

/** The conversation as a person saw it: their words and the assistant's text. */
export function parseClaudeHistory(fileText: string): Array<HistoryMessage> {
  const rows = parseJsonLines(fileText);
  const messages: Array<HistoryMessage> = [];
  // One assistant message spans several lines, one content block each.
  const assistantAt = new Map<string, number>();
  for (const row of currentBranch(rows)) {
    const createdAt = isoDate(row["timestamp"]);
    const uuid = asString(row["uuid"]);
    if (createdAt === null || uuid === null) continue;
    if (row["type"] === "user") {
      const text = userText(row);
      if (text !== null) messages.push({ id: uuid, role: "user", text, createdAt });
      continue;
    }
    const text = assistantText(row);
    if (text === null) continue;
    const messageId = asString(asRecord(row["message"])?.["id"]);
    const known = messageId === null ? undefined : assistantAt.get(messageId);
    if (known !== undefined) {
      const earlier = messages[known]!;
      messages[known] = { ...earlier, text: `${earlier.text}\n\n${text}` };
      continue;
    }
    if (messageId !== null) assistantAt.set(messageId, messages.length);
    messages.push({ id: uuid, role: "assistant", text, createdAt });
  }
  return messages;
}
