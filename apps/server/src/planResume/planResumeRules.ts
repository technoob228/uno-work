/**
 * What the daemon does with a chat that stopped at the plan's limit: the rules
 * without the wiring, so each promise made to the person has its own test.
 *
 * - One automatic try per case: a case is the person's last request. The
 *   continuation is a message of its own, so a repeat of the limit right after
 *   it has that message as the last request and is left alone.
 * - The person always wins: a new message, Stop, a chat moved to another
 *   computer — anything newer than the stop ends the wait.
 */
import type { OrchestrationSessionStatus, ThreadId, TurnId } from "@t3tools/contracts";
import { isPlanLimitText, PLAN_RESUME_MESSAGE_PREFIX } from "@t3tools/shared/planLimitRules";

/** A stop older than this is history (a session starting again), not a chat stopping now. */
export const FRESH_STOP_MS = 2 * 60_000;

export interface PlanResumeRow {
  readonly resumeId: string;
  readonly threadId: ThreadId;
  readonly stoppedTurnId: TurnId | null;
  readonly lastUserMessageId: string | null;
  readonly resumeAt: string;
}

export interface ThreadTail {
  /** The newest message of the chat. */
  readonly latest: {
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: string;
  } | null;
  readonly lastUserMessageId: string | null;
}

export interface ThreadState {
  readonly archived: boolean;
  readonly sessionStatus: OrchestrationSessionStatus | null;
  readonly activeTurnId: TurnId | null;
  readonly latestTurnId: TurnId | null;
  readonly latestTurnState: string | null;
}

const isWorking = (state: ThreadState) =>
  state.activeTurnId !== null ||
  state.sessionStatus === "running" ||
  state.sessionStatus === "starting";

/**
 * The line that stopped the chat, if it did: the turn's error (Codex), or the
 * last reply (Claude Code ends the turn with it as a short "answer"). Null
 * while the turn runs, after the person pressed Stop, or for an old stop.
 */
export function stopLineOf(input: {
  readonly state: ThreadState;
  readonly tail: ThreadTail;
  readonly sessionError: string | null;
  readonly now: number;
}): string | null {
  const { state, tail, sessionError, now } = input;
  if (state.archived || isWorking(state)) return null;
  if (state.latestTurnState === "interrupted") return null;
  if (sessionError !== null && isPlanLimitText(sessionError)) return sessionError;
  const latest = tail.latest;
  if (latest === null || latest.role !== "assistant" || latest.streaming) return null;
  if (now - Date.parse(latest.createdAt) > FRESH_STOP_MS) return null;
  return isPlanLimitText(latest.text) ? latest.text : null;
}

/** The chat's last request was the daemon's own continuation: this case had its try. */
export function hadItsTry(tail: ThreadTail): boolean {
  return tail.lastUserMessageId?.startsWith(PLAN_RESUME_MESSAGE_PREFIX) ?? false;
}

export type DueDecision =
  | { readonly kind: "resume" }
  | { readonly kind: "end"; readonly reason: "chat-gone" | "someone-went-on" };

/** A waiting chat is due: is it still the chat that stopped? */
export function decideDue(input: {
  readonly row: PlanResumeRow;
  readonly state: ThreadState | null;
  readonly tail: ThreadTail;
}): DueDecision {
  const { row, state, tail } = input;
  if (state === null || state.archived) return { kind: "end", reason: "chat-gone" };
  if (isWorking(state)) return { kind: "end", reason: "someone-went-on" };
  if (state.latestTurnId !== row.stoppedTurnId) return { kind: "end", reason: "someone-went-on" };
  if (tail.lastUserMessageId !== row.lastUserMessageId) {
    return { kind: "end", reason: "someone-went-on" };
  }
  return { kind: "resume" };
}
