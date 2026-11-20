/**
 * "A cloud chat asks to start a chat here" (contracts chatRequests.ts, Misha
 * 20.11): what Uno Work on the person's own computer shows of the requests —
 * the waiting ones (Needs you, the sidebar, the brief) and the journal
 * (Settings → Computer). Pure; the store polls, the components draw.
 */
import type { ChatRequestStatus, ChatRequestView, ChatRequestsState } from "@t3tools/contracts";

/** The folder line: as asked, or the server's choice. */
export const LAST_PROJECT_LABEL = "the project used last";

/** How many decided ones the journal in Settings lists. */
export const JOURNAL_MAX = 8;

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  uno: "Uno AI",
};

/** Waiting for Start / Decline, newest first (the server's order), not yet run out. */
export function waitingRequests(
  state: ChatRequestsState | null,
  nowMs: number = Date.now(),
): ReadonlyArray<ChatRequestView> {
  if (!state) return [];
  return state.requests.filter(
    (request) => request.status === "waiting" && !expiredBy(request, nowMs),
  );
}

export function waitingCount(state: ChatRequestsState | null, nowMs: number = Date.now()): number {
  return waitingRequests(state, nowMs).length;
}

function expiredBy(request: ChatRequestView, nowMs: number): boolean {
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at <= nowMs;
}

/** Requests that started waiting since the previous answer: one notification each. */
export function newlyWaiting(
  previous: ChatRequestsState | null,
  next: ChatRequestsState,
  nowMs: number = Date.now(),
): ReadonlyArray<ChatRequestView> {
  const seen = new Set(waitingRequests(previous, nowMs).map((request) => request.id));
  // The first answer after the app opens: what already waits isn't news, the
  // sidebar and Needs you show it (no burst of notifications on every start).
  if (previous === null) return [];
  return waitingRequests(next, nowMs).filter((request) => !seen.has(request.id));
}

/** «<thread> on <computer> wants to start a chat here» — the card's and the notification's title. */
export function requestTitle(request: ChatRequestView): string {
  return `${fromTitle(request)} on ${computerName(request)} wants to start a chat here`;
}

/** The cloud chat that asks, by its title. */
export function fromTitle(request: ChatRequestView): string {
  return request.from.threadTitle.trim() || request.title.trim() || "A chat";
}

export function computerName(request: ChatRequestView): string {
  return request.from.computerName.trim() || "your cloud computer";
}

export function folderLabel(cwd: string | null): string {
  const folder = cwd?.trim() ?? "";
  return folder === "" ? LAST_PROJECT_LABEL : folder;
}

export function harnessLabel(provider: string | null): string {
  if (!provider) return "Claude Code";
  return HARNESS_LABELS[provider] ?? provider;
}

/** "13:45" in the person's own clock. */
export function clockLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "waits until 13:45" — the 2 h are counted on the server, this only says when. */
export function waitsUntilLabel(request: ChatRequestView): string {
  const clock = clockLabel(request.expiresAt);
  return clock ? `waits until ${clock}` : "waits for you";
}

/** The journal's time: today "14:05", else "Nov 18, 14:05". */
export function journalTimeLabel(iso: string, nowMs: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const clock = clockLabel(iso);
  if (sameDay) return clock;
  const day = at.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${clock}`;
}

export type ChatRequestTone = "waiting" | "started" | "declined" | "ended";

export interface StatusChip {
  readonly label: string;
  readonly tone: ChatRequestTone;
}

export function statusChip(status: ChatRequestStatus): StatusChip {
  switch (status) {
    case "waiting":
    case "queued":
      return { label: "Waiting", tone: "waiting" };
    case "started":
      return { label: "Started", tone: "started" };
    case "declined":
      return { label: "Declined", tone: "declined" };
    case "expired":
      return { label: "Expired", tone: "ended" };
    case "refused":
      return { label: "Refused", tone: "ended" };
  }
}

/** The journal in Settings: newest first, waiting ones included, at most `JOURNAL_MAX`. */
export function journalEntries(state: ChatRequestsState | null): ReadonlyArray<ChatRequestView> {
  if (!state) return [];
  return state.requests.slice(0, JOURNAL_MAX);
}

/** When a journal entry happened: decided, else asked. */
export function journalAt(request: ChatRequestView): string {
  return request.decidedAt ?? request.createdAt;
}

/** What the new chat is held to, for the brief dialog. */
export function startsWithLine(request: ChatRequestView): string {
  return `The chat starts in ${folderLabel(request.cwd)} with ${harnessLabel(request.provider)}.`;
}

export const HELD_TO_LINE = "It can't ssh to servers, deploy, push, use sudo or read secrets here.";

/** An RPC failure → the server's sentence (the limit, a request that ran out). */
export function failureMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return "Uno Work on this computer didn't answer. Try again.";
}
