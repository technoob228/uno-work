/**
 * "A cloud chat asks to start a chat here" (contracts chatRequests.ts, Misha
 * 20.11): what Uno Work on the person's own computer shows of the requests —
 * the waiting ones (Needs you, the sidebar, the brief) and the journal
 * (Settings → Computer). Pure; the store polls, the components draw.
 */
import type {
  ChatRequestStatus,
  ChatRequestView,
  ChatRequestsState,
  RemoteCommandLine,
} from "@t3tools/contracts";

import { teamSessionHeadline } from "../team/team.logic";

/** The folder line: as asked, or the server's choice. */
export const LAST_PROJECT_LABEL = "the project used last";

/** How many decided ones the journal in Settings lists. */
export const JOURNAL_MAX = 8;

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  grok: "Grok",
  antigravity: "Antigravity",
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

/**
 * T51: a request carrying `team` comes from a colleague (or their agent) in a
 * team project; it shows under "From your team", not "Chats from the cloud".
 */
export const isTeamRequest = (request: ChatRequestView) => request.team !== undefined;

/** The person's own cloud chats asking (Chats from the cloud, the sidebar). */
export function ownWaitingRequests(
  state: ChatRequestsState | null,
  nowMs: number = Date.now(),
): ReadonlyArray<ChatRequestView> {
  return waitingRequests(state, nowMs).filter((request) => !isTeamRequest(request));
}

/** A colleague's session requests (From your team). */
export function teamWaitingRequests(
  state: ChatRequestsState | null,
  nowMs: number = Date.now(),
): ReadonlyArray<ChatRequestView> {
  return waitingRequests(state, nowMs).filter(isTeamRequest);
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
  if (request.team) return teamSessionHeadline(request.team);
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

export const HELD_TO_LINE =
  "It can't ssh to servers, deploy, use sudo or read secrets here. A git push or an install asks you each time.";

/** The toggle on a request: "Don't ask again for this chat". */
export const TRUST_CHAT_LABEL = "Don't ask again for this chat";

/** What the toggle means, next to it. */
export const TRUST_CHAT_HINT =
  "Its next requests start without Start while cloud agents are on here. You can revoke it in Settings → Computer.";

/** An RPC failure → the server's sentence (the limit, a request that ran out). */
export function failureMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return "Uno Work on this computer didn't answer. Try again.";
}

/** Settings → Computer → Cloud agents: how many of their last commands show. */
export const COMMANDS_SHOWN = 30;

export type CommandTone = "ran" | "allowed" | "refused";

/** A cloud agent's call here, as its chip says it. */
export function commandChip(line: RemoteCommandLine): {
  readonly label: string;
  readonly tone: CommandTone;
} {
  switch (line.outcome) {
    case "allowed":
      return { label: "Allowed", tone: "allowed" };
    case "refused":
      return { label: "Refused", tone: "refused" };
    default:
      return { label: "Ran", tone: "ran" };
  }
}

const COMMAND_KINDS: Readonly<Record<string, string>> = {
  run: "Ran",
  read: "Read",
  write: "Wrote",
  list: "Listed",
};

/** "Ran: git status" — the verb, then what. */
export function commandSummary(line: RemoteCommandLine): string {
  const verb = COMMAND_KINDS[line.kind] ?? line.kind;
  return `${verb}: ${line.summary}`;
}

export function commandEntries(state: ChatRequestsState | null): ReadonlyArray<RemoteCommandLine> {
  return (state?.commands ?? []).slice(0, COMMANDS_SHOWN);
}

/** The switch's status line. */
export function cloudAgentsStatus(state: ChatRequestsState): string {
  if (state.allow) {
    return `On. Requests wait up to 2 hours, at most ${state.limit} at once: ${state.active} now.`;
  }
  if (state.stoppedAt) {
    return `Stopped at ${journalTimeLabel(state.stoppedAt)}. Nothing from the cloud runs here until you turn this on.`;
  }
  return "Off. Cloud agents are refused at once and told it can be turned on here.";
}
