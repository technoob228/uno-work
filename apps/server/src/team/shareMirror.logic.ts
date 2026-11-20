/**
 * A shared chat's feed as the colleague reads it (T51 (a)), built from this
 * computer's chat. Pure: shareMirror.ts reads the chat and sends.
 *
 * - Only what the person and the agent said, and one line per turn of what
 *   the agent did ("Ran 3 commands, edited 2 files"): never a tool's output,
 *   a command line or a file's content (they carry keys).
 * - The first look sends the last 200 messages; then each change. A message
 *   that is still streaming goes at most every 2 s; its final text at once.
 * - Text is cut to the server's 16 000 characters; a batch is at most 100
 *   events and 1 MB.
 * - What was sent is remembered by a short hash per message, so a restart
 *   sends only what changed meanwhile.
 * - Notes Uno Work itself put into the chat for the team (a colleague's
 *   message, an answer from their agent) are not sent back: the server has
 *   the colleague's own event for them.
 *
 * @module team/shareMirror.logic
 */
import * as crypto from "node:crypto";

import type { TeamChatStatus } from "@t3tools/contracts";

export const SNAPSHOT_MESSAGES = 200;
export const EVENT_TEXT_MAX_CHARS = 16_000;
export const BATCH_MAX_EVENTS = 100;
export const BATCH_MAX_BYTES = 1_000_000;
/** A streaming message goes at most this often. */
export const STREAM_EVERY_MS = 2_000;
/** Message hashes remembered per chat (the snapshot is 200). */
export const SENT_KEEP = 400;
/** How long a failed send waits, at most. */
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Every note Uno Work puts into a chat for the team starts so (inbound.ts, bridge.ts). */
export const TEAM_NOTE_PREFIX = "[Uno Work · team]";

export type MirrorRole = "user" | "assistant" | "activity";

export interface MirrorEvent {
  readonly messageId: string;
  readonly role: MirrorRole;
  readonly text: string;
  readonly at: string;
}

export interface MirrorMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export interface ToolCounts {
  readonly commands: number;
  readonly edits: number;
  readonly other: number;
}

export const NO_TOOLS: ToolCounts = { commands: 0, edits: 0, other: 0 };

/** A finished tool call of a turn, by its item type (`tool.completed` activities). */
export function countTool(counts: ToolCounts, itemType: unknown): ToolCounts {
  if (itemType === "command_execution") return { ...counts, commands: counts.commands + 1 };
  if (itemType === "file_change") return { ...counts, edits: counts.edits + 1 };
  return { ...counts, other: counts.other + 1 };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Ran 3 commands, edited 2 files, used 1 tool"; null when the turn used none. */
export function activityLine(counts: ToolCounts): string | null {
  const parts = [
    counts.commands > 0 ? `ran ${plural(counts.commands, "command", "commands")}` : null,
    counts.edits > 0 ? `edited ${plural(counts.edits, "file", "files")}` : null,
    counts.other > 0 ? `used ${plural(counts.other, "tool", "tools")}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const line = parts.join(", ");
  return `${line[0]!.toUpperCase()}${line.slice(1)}`;
}

export const activityMessageId = (turnId: string) => `activity:${turnId}`;

/** The person's or the agent's message, not a note Uno Work wrote for the team. */
export function isMirrored(message: Pick<MirrorMessage, "role" | "text">): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.text.trim().length === 0) return false;
  return !(message.role === "user" && message.text.startsWith(TEAM_NOTE_PREFIX));
}

export function clipText(text: string, max = EVENT_TEXT_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The first look: the last 200 messages, each turn's activity line before
 * that turn's first answer.
 */
export function snapshotEvents(
  messages: ReadonlyArray<MirrorMessage>,
  toolsByTurn: ReadonlyMap<string, ToolCounts>,
  max = SNAPSHOT_MESSAGES,
): ReadonlyArray<MirrorEvent> {
  const kept = messages.filter(isMirrored).slice(-max);
  const out: Array<MirrorEvent> = [];
  const lined = new Set<string>();
  for (const message of kept) {
    if (message.role === "assistant" && message.turnId !== null && !lined.has(message.turnId)) {
      lined.add(message.turnId);
      const line = activityLine(toolsByTurn.get(message.turnId) ?? NO_TOOLS);
      if (line !== null) {
        out.push({
          messageId: activityMessageId(message.turnId),
          role: "activity",
          text: line,
          at: message.createdAt,
        });
      }
    }
    out.push({
      messageId: message.id,
      role: message.role as "user" | "assistant",
      text: clipText(message.text),
      at: message.createdAt,
    });
  }
  return out;
}

/** A short hash of what went out (text and role), to tell what changed since. */
export function eventHash(event: Pick<MirrorEvent, "role" | "text">): string {
  return crypto
    .createHash("sha256")
    .update(`${event.role}\u0000${event.text}`)
    .digest("base64url")
    .slice(0, 16);
}

/** The events whose text isn't what was sent last. */
export function unsent(
  events: ReadonlyArray<MirrorEvent>,
  sent: Readonly<Record<string, string>>,
): ReadonlyArray<MirrorEvent> {
  return events.filter((event) => sent[event.messageId] !== eventHash(event));
}

/** The record of sent hashes after a batch went, the oldest beyond {@link SENT_KEEP} dropped. */
export function rememberSent(
  sent: Readonly<Record<string, string>>,
  events: ReadonlyArray<MirrorEvent>,
  keep = SENT_KEEP,
): Record<string, string> {
  const next: Record<string, string> = { ...sent };
  for (const event of events) {
    delete next[event.messageId];
    next[event.messageId] = eventHash(event);
  }
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) delete next[id];
  return next;
}

const eventBytes = (event: MirrorEvent) =>
  Buffer.byteLength(
    JSON.stringify({
      message_id: event.messageId,
      role: event.role,
      text: event.text,
      at: event.at,
    }),
    "utf8",
  );

/** In order, ≤ 100 events and ≤ 1 MB each (an event is never split). */
export function batches(
  events: ReadonlyArray<MirrorEvent>,
  maxEvents = BATCH_MAX_EVENTS,
  maxBytes = BATCH_MAX_BYTES,
): ReadonlyArray<ReadonlyArray<MirrorEvent>> {
  const out: Array<Array<MirrorEvent>> = [];
  let current: Array<MirrorEvent> = [];
  let bytes = 0;
  for (const event of events) {
    const size = eventBytes(event);
    if (current.length > 0 && (current.length >= maxEvents || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The chat's state for the colleague: running, waiting for the person, or idle. */
export function threadStatusOf(shell: {
  readonly session?: { readonly status: string; readonly activeTurnId?: string | null } | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): TeamChatStatus {
  if (shell.hasPendingApprovals === true || shell.hasPendingUserInput === true) return "waiting";
  const status = shell.session?.status;
  if (
    status === "running" ||
    status === "starting" ||
    (shell.session?.activeTurnId ?? null) !== null
  )
    return "running";
  return "idle";
}

/** After `failures` failed sends in a row: how long to wait (2 s, 4 s, … 5 min). */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, 2_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * A streaming message: the text so far (the chat's events carry deltas) and
 * whether it is time to send it again.
 */
export interface StreamState {
  readonly text: string;
  readonly lastSentAt: number;
}

export function onStreamDelta(
  state: StreamState | undefined,
  delta: string,
  nowMs: number,
): { readonly state: StreamState; readonly send: boolean } {
  const text = `${state?.text ?? ""}${delta}`;
  const due = state === undefined ? true : nowMs - state.lastSentAt >= STREAM_EVERY_MS;
  return { state: { text, lastSentAt: due ? nowMs : (state?.lastSentAt ?? nowMs) }, send: due };
}
