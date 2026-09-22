/**
 * wait_for_thread — the pure half.
 *
 * A dispatcher that polls `get_thread_status` in a loop burns its own limits
 * and context on every poll. `wait_for_thread` blocks daemon-side instead:
 * the tool layer wakes up on orchestration events for the thread (plus a rare
 * fallback poll) and asks {@link evaluateThreadWait} whether the thread's
 * current turn has settled.
 *
 * Turn state is read from the turn rows (`projection_turns`), not from the
 * shell's `latestTurn`: the latter tracks the session's active turn and is
 * nulled as soon as the session goes idle (see `resolveTurnReply` in the
 * Telegram connector, which learned this the hard way).
 */
import type {
  OrchestrationCheckpointFile,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  MANAGER_WAIT_MAX_CHANGED_FILES,
  MANAGER_WAIT_REPLY_MAX_CHARS,
  type ManagerWaitStatus,
} from "@t3tools/contracts";

import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import { wrapUntrustedContent } from "../untrustedContent.ts";

/** Fallback poll when no orchestration event arrives (events are the fast path). */
export const WAIT_FALLBACK_POLL_MS = 15_000;
/** Coalesces bursts of events (streaming deltas) into one re-evaluation. */
export const WAIT_EVENT_DEBOUNCE_MS = 250;
/**
 * A harness may write its final message shortly after the turn row turns
 * terminal (hermes always does). Hold a completed turn without a reply this
 * long before returning it reply-less.
 */
export const WAIT_REPLY_GRACE_MS = 20_000;
/**
 * A queued/running turn row with no live session behind it for this long is
 * treated as lost (the turn never started or the runtime vanished).
 */
export const WAIT_STALE_INFLIGHT_MS = 120_000;

const ACTIVE_SESSION_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "starting",
  "running",
]);
const DEAD_SESSION_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "stopped",
  "error",
]);

export type WaitTurnRow = Pick<
  ProjectionTurn,
  | "turnId"
  | "state"
  | "requestedAt"
  | "startedAt"
  | "completedAt"
  | "assistantMessageId"
  | "checkpointStatus"
  | "checkpointFiles"
>;

export interface ThreadWaitProbe {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly updatedAt: string;
    readonly lastError: string | null;
  } | null;
  readonly turns: ReadonlyArray<WaitTurnRow>;
  readonly nowMs: number;
}

export type SettledWaitStatus = Exclude<ManagerWaitStatus, "timeout" | "running">;

export type ThreadWaitVerdict =
  | { readonly settled: false }
  | {
      readonly settled: true;
      readonly status: SettledWaitStatus;
      /** The turn the verdict is about (latest concrete turn), if any. */
      readonly turn: WaitTurnRow | null;
      readonly error: string | null;
    };

const NOT_SETTLED: ThreadWaitVerdict = { settled: false };

const byRequestedAtDesc = (a: WaitTurnRow, b: WaitTurnRow) =>
  b.requestedAt.localeCompare(a.requestedAt);

const toMs = (iso: string) => new Date(iso).getTime();

export const evaluateThreadWait = (probe: ThreadWaitProbe): ThreadWaitVerdict => {
  const concrete = probe.turns.filter((turn) => turn.turnId !== null).toSorted(byRequestedAtDesc);
  const latest = concrete[0] ?? null;

  if (probe.hasPendingApprovals || probe.hasPendingUserInput) {
    return { settled: true, status: "needs_user", turn: latest, error: null };
  }

  const session = probe.session;
  if (session !== null && ACTIVE_SESSION_STATUSES.has(session.status)) {
    return NOT_SETTLED;
  }

  const inflight = probe.turns
    .filter((turn) => turn.state === "pending" || turn.state === "running")
    .toSorted(byRequestedAtDesc)[0];
  if (inflight !== undefined) {
    // «stopped»/«error» stamped BEFORE the request is a stale status of an
    // earlier run: dispatch is exactly what (re)starts the session.
    const sessionDied =
      session !== null &&
      DEAD_SESSION_STATUSES.has(session.status) &&
      session.updatedAt >= inflight.requestedAt;
    if (sessionDied) {
      return {
        settled: true,
        status: "error",
        turn: latest,
        error: session.lastError ?? `The harness session ${session.status} before the turn ended.`,
      };
    }
    const lastSignalMs = Math.max(
      toMs(inflight.requestedAt),
      session === null ? 0 : toMs(session.updatedAt),
    );
    if (probe.nowMs - lastSignalMs < WAIT_STALE_INFLIGHT_MS) {
      return NOT_SETTLED;
    }
    return {
      settled: true,
      status: "error",
      turn: latest,
      error: `The turn is ${inflight.state} but the session is ${session?.status ?? "absent"}; it looks lost.`,
    };
  }

  if (latest === null) {
    if (session !== null && DEAD_SESSION_STATUSES.has(session.status)) {
      return { settled: true, status: "error", turn: null, error: session.lastError };
    }
    return { settled: true, status: "idle", turn: null, error: null };
  }

  switch (latest.state) {
    case "error":
      return { settled: true, status: "error", turn: latest, error: session?.lastError ?? null };
    case "interrupted":
      return { settled: true, status: "interrupted", turn: latest, error: null };
    default:
      return { settled: true, status: "completed", turn: latest, error: null };
  }
};

export interface WaitMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
}

/** The assistant message that answers `turn`, if it has landed. */
export const findTurnReply = (
  turn: WaitTurnRow | null,
  messages: ReadonlyArray<WaitMessage>,
): WaitMessage | null => {
  const assistant = messages.filter(
    (message) =>
      message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
  );
  if (turn === null) {
    return assistant.at(-1) ?? null;
  }
  if (turn.assistantMessageId !== null) {
    const exact = assistant.find((message) => message.id === turn.assistantMessageId);
    if (exact !== undefined) return exact;
  }
  return assistant.findLast((message) => message.createdAt >= turn.requestedAt) ?? null;
};

/** Hold a freshly completed turn a little while its final message lands. */
export const shouldHoldForReply = (
  verdict: ThreadWaitVerdict,
  reply: WaitMessage | null,
  nowMs: number,
): boolean => {
  if (!verdict.settled || verdict.status !== "completed" || reply !== null) {
    return false;
  }
  const terminalAt = verdict.turn?.completedAt ?? verdict.turn?.requestedAt;
  return terminalAt !== undefined && nowMs - toMs(terminalAt) < WAIT_REPLY_GRACE_MS;
};

export const clipReply = (
  reply: WaitMessage | null,
): { readonly text: string | null; readonly truncated: boolean } => {
  if (reply === null) return { text: null, truncated: false };
  const truncated = reply.text.length > MANAGER_WAIT_REPLY_MAX_CHARS;
  const text = truncated ? reply.text.slice(0, MANAGER_WAIT_REPLY_MAX_CHARS) : reply.text;
  return { text: wrapUntrustedContent(text), truncated };
};

export const changedFilesOf = (
  turn: WaitTurnRow | null,
): {
  readonly files: ReadonlyArray<OrchestrationCheckpointFile> | null;
  readonly total: number;
} => {
  if (turn === null || turn.checkpointStatus === null) {
    return { files: null, total: 0 };
  }
  return {
    files: turn.checkpointFiles.slice(0, MANAGER_WAIT_MAX_CHANGED_FILES),
    total: turn.checkpointFiles.length,
  };
};

export const turnDurationMs = (turn: WaitTurnRow | null): number | null => {
  if (turn === null || turn.completedAt === null) return null;
  const start = turn.startedAt ?? turn.requestedAt;
  return Math.max(0, toMs(turn.completedAt) - toMs(start));
};

const PENDING_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "user-input.requested",
]);
const PENDING_REQUEST_MAX_CHARS = 600;

/** What a `needs_user` thread is asking, from its latest request activity. */
export const describePendingRequest = (
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "summary" | "payload">>,
): string | null => {
  const request = activities.findLast((activity) => PENDING_REQUEST_KINDS.has(activity.kind));
  if (request === undefined) return null;
  const payload =
    typeof request.payload === "object" && request.payload !== null
      ? (request.payload as { readonly detail?: unknown })
      : {};
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const text = detail.length > 0 ? `${request.summary}\n${detail}` : request.summary;
  return wrapUntrustedContent(text.slice(0, PENDING_REQUEST_MAX_CHARS));
};

/** Does this orchestration event concern one of the watched threads? */
export const eventTouchesThreads = (
  event: { readonly type: string; readonly aggregateId: string; readonly payload: unknown },
  threadIds: ReadonlySet<string>,
): boolean => {
  if (event.type === "thread.message-sent") {
    // Streaming deltas never settle a turn; skip the burst.
    const payload = event.payload as { readonly streaming?: unknown };
    if (payload.streaming === true) return false;
  }
  if (threadIds.has(event.aggregateId)) return true;
  const payload = event.payload as { readonly threadId?: unknown } | null;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof payload.threadId === "string" &&
    threadIds.has(payload.threadId)
  );
};
