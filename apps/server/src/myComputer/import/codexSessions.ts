/**
 * Codex sessions: `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, or
 * `.jsonl.zst` where it compresses old ones. Taken from real sessions of 0.166
 * and Codex's sources (see the M3 section in the plan).
 *
 * The same conversation is written twice, as `response_item` and as events.
 * `response_item` is the one every version has; events are the fallback.
 *
 * @module myComputer/import/codexSessions
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

/** What Codex itself sends as a user turn: environment, instructions, skills. */
const INJECTED_TEXT =
  /^\s*(?:<[a-z][\w-]*[\s>]|#\s*AGENTS\.md instructions|The user interrupted the previous turn)/i;

const blocksText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => asString(asRecord(block)?.["text"]) ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
};

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** A conversation turn from `response_item`, or null. */
function responseTurn(row: Row): Turn | null {
  if (row["type"] !== "response_item") return null;
  const payload = asRecord(row["payload"]);
  if (payload?.["type"] !== "message") return null;
  const role = payload["role"];
  if (role !== "user" && role !== "assistant") return null;
  const text = blocksText(payload["content"]).trim();
  if (text.length === 0) return null;
  if (role === "user" && INJECTED_TEXT.test(text)) return null;
  return { role, text };
}

/** The same turn from an event: 0.166 `item_completed`, older `user_message`. */
function eventTurn(row: Row): Turn | null {
  if (row["type"] !== "event_msg") return null;
  const payload = asRecord(row["payload"]);
  const type = payload?.["type"];
  if (type === "user_message" || type === "agent_message") {
    const text = asString(payload?.["message"])?.trim();
    if (!text || (type === "user_message" && INJECTED_TEXT.test(text))) return null;
    return { role: type === "user_message" ? "user" : "assistant", text };
  }
  if (type === "item_completed") {
    const item = asRecord(payload?.["item"]);
    const kind = item?.["type"];
    if (kind !== "UserMessage" && kind !== "AgentMessage") return null;
    const text = blocksText(item?.["content"]).trim();
    if (text.length === 0 || (kind === "UserMessage" && INJECTED_TEXT.test(text))) return null;
    return { role: kind === "UserMessage" ? "user" : "assistant", text };
  }
  return null;
}

const isCodexRow = (row: Row) =>
  typeof row["type"] === "string" && asRecord(row["payload"]) !== null;

/** A session Codex started for itself, not one the person talked to. */
function isBackgroundSource(source: unknown): boolean {
  if (typeof source === "string") {
    const lower = source.toLowerCase();
    return lower === "subagent" || lower === "internal";
  }
  const record = asRecord(source);
  return record !== null && ("subagent" in record || "subAgent" in record);
}

export function peekCodexSession(peek: SessionPeek): PeekResult {
  const head = headRows(peek);
  const tail = tailRows(peek);
  const meta = head.find((row) => row["type"] === "session_meta");
  const metaPayload = asRecord(meta?.["payload"]);
  // session_meta carries the base instructions: it may be longer than the head.
  const rawMeta = peek.head.includes('"session_meta"');
  if (head.length === 0 && !rawMeta) return { kind: "broken" };
  if (head.length > 0 && !rawMeta && !head.some(isCodexRow)) return { kind: "unknown-format" };
  if (isBackgroundSource(metaPayload?.["source"])) return { kind: "not-a-chat" };

  const rows = [...head, ...tail];
  const firstTurn =
    rows.map(responseTurn).find((turn) => turn?.role === "user") ??
    rows.map(eventTurn).find((turn) => turn?.role === "user") ??
    null;
  const anyTurn = firstTurn !== null || rows.some((row) => responseTurn(row) ?? eventTurn(row));
  // A session too long to show its first turn in the head is still a chat.
  if (!anyTurn && !peek.headCut) return { kind: "not-a-chat" };

  const timestamps = rows.map((row) => isoDate(row["timestamp"])).filter((at) => at !== null);
  return {
    kind: "chat",
    title: cleanTitle(firstTurn?.text),
    cwd: asString(metaPayload?.["cwd"]) ?? extractJsonString(peek.head, "cwd"),
    startedAt:
      isoDate(metaPayload?.["timestamp"]) ??
      timestamps[0] ??
      isoDate(extractJsonString(peek.head, "timestamp")),
    lastActiveAt: timestamps.at(-1) ?? null,
  };
}

/** `session_index.jsonl`: names the person gave threads, latest line wins. */
export function parseCodexIndex(fileText: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const row of parseJsonLines(fileText)) {
    const id = asString(row["id"]);
    const name = cleanTitle(asString(row["thread_name"]));
    if (id !== null && name !== null) names.set(id, name);
  }
  return names;
}

export function parseCodexHistory(fileText: string): Array<HistoryMessage> {
  const rows = parseJsonLines(fileText);
  const collect = (read: (row: Row) => Turn | null) =>
    rows.flatMap((row, index) => {
      const turn = read(row);
      const createdAt = isoDate(row["timestamp"]);
      if (turn === null || createdAt === null) return [];
      return [{ id: `line-${index}`, role: turn.role, text: turn.text, createdAt }];
    });
  const fromItems = collect(responseTurn);
  return fromItems.length > 0 ? fromItems : collect(eventTurn);
}
