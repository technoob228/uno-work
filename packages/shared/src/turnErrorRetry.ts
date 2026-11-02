/**
 * Which failed turns are "not the person's problem" and how Uno Work retries
 * them — shared by the daemon (it continues the turn by itself, with no tab
 * open) and the client (the calm "Try again" line once the daemon gave up).
 *
 * "AI is busy" and "the model didn't answer" lose nothing: the files the
 * agent wrote are there and the harness keeps the conversation. A person who
 * closed the laptop came back to "Failed" after a single gateway timeout
 * (customer walkthrough 25.10.2026: 9 minutes of work, then one
 * `upstream_timeout`; "Try again" 13 minutes later finished the task in 1.5).
 * So the daemon continues such a turn itself, at most
 * {@link TURN_AUTO_RETRY_MAX_ATTEMPTS} times per chain of turns.
 *
 * The gateway keeps the openings of these sentences stable (fishcode
 * llm/ai_lane.go AIBusyMessage, llm/stream_guard.go UpstreamTimeoutMessage);
 * the rest of the sentence is written for agents ("Retry-After header", "run
 * fewer agents in parallel") and is not shown to the person.
 */

export type TurnErrorKind = "busy" | "no-answer" | "agent-stopped" | "other";

export interface TurnErrorNotice {
  readonly kind: TurnErrorKind;
  /** Seconds the gateway asked to wait before the retry ("busy" only). */
  readonly retryAfterSeconds: number;
}

export const BUSY_DEFAULT_RETRY_SECONDS = 10;
const BUSY_MAX_RETRY_SECONDS = 120;

const BUSY_PATTERNS: ReadonlyArray<RegExp> = [
  /uno ai is busy for you/i,
  // Gateways before 08.10 and other providers' own words for the same thing.
  /too many ai requests are running/i,
  /\bai_busy\b/i,
  /\b429\b.*\b(?:too many requests|rate limit)/i,
  /\brate[ _-]?limit(?:ed)?\b.*\b(?:exceeded|reached|try again)/i,
  /\boverloaded(?:_error)?\b/i,
];

const NO_ANSWER_PATTERNS: ReadonlyArray<RegExp> = [
  /uno ai didn.t answer in time/i,
  // The gateway's broken stream (fishcode api/llm.go streamFailureMessage,
  // type upstream_error): continued like a timeout (Misha 29.10). Only the
  // sentence: `upstream_error` alone also names a provider's refusals.
  /uno ai stopped answering/i,
  /uno did not answer this time/i,
  /\bupstream_timeout\b/i,
  /\b(?:model|provider|upstream) (?:did not|didn.t) (?:answer|respond)/i,
  /\b(?:first token|upstream|gateway) time(?:d)? ?out\b/i,
  /\b50[234]\b.*\b(?:bad gateway|service unavailable|gateway timeout)/i,
  /\bempty (?:response|completion) from (?:the )?(?:model|provider)/i,
];

/**
 * The agent's process ended in the middle of a turn: out of memory, killed by
 * something on the computer. Its conversation is saved, the next turn resumes
 * it. An exit caused by Uno Work stopping never gets here (daemonStopping.ts).
 */
const AGENT_STOPPED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bOpenCode server exited unexpectedly\b/i,
  /\bCodex App Server exited\b/i,
  /\bACP process exited\b/i,
];

function retryAfter(error: string): number {
  const match =
    /retry[ _-]?after[^0-9]{0,12}(\d{1,3})/i.exec(error) ??
    /(?:try again|retry) in (\d{1,3})\s*s/i.exec(error);
  const seconds = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, BUSY_MAX_RETRY_SECONDS)
    : BUSY_DEFAULT_RETRY_SECONDS;
}

export function classifyTurnError(error: string): TurnErrorNotice {
  if (BUSY_PATTERNS.some((pattern) => pattern.test(error))) {
    return { kind: "busy", retryAfterSeconds: retryAfter(error) };
  }
  if (NO_ANSWER_PATTERNS.some((pattern) => pattern.test(error))) {
    return { kind: "no-answer", retryAfterSeconds: 0 };
  }
  if (AGENT_STOPPED_PATTERNS.some((pattern) => pattern.test(error))) {
    return { kind: "agent-stopped", retryAfterSeconds: 0 };
  }
  return { kind: "other", retryAfterSeconds: 0 };
}

/**
 * Our own words for "the agent didn't start": written for a developer, and they
 * say nothing a person can act on (`ProviderAdapterProcessError: Provider
 * adapter process error (opencode) for thread 644d…`, a stack). A sentence an
 * agent or the gateway wrote for people ("Claude is not signed in…") stays.
 */
export function isInternalTurnFailure(error: string): boolean {
  return /\bProvider[A-Za-z]*Error\b|\bProvider adapter\b|\n\s+at\s/.test(error);
}

// ── Automatic continuation (daemon) ─────────────────────────────────────

/** Automatic continuations per chain of turns; the person's next message starts a new chain. */
export const TURN_AUTO_RETRY_MAX_ATTEMPTS = 2;
/**
 * "Didn't answer": the gateway or the model had a bad moment — a short wait,
 * then a longer one. Index = attempt − 1.
 */
export const NO_ANSWER_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 45_000];

export type AutoRetryKind = Exclude<TurnErrorKind, "other">;

export type TurnAutoRetryDecision =
  | {
      readonly retry: true;
      readonly kind: AutoRetryKind;
      /** 1-based number of this automatic continuation. */
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
    }
  | {
      readonly retry: false;
      readonly reason: "not-retryable" | "attempts-used";
    };

/**
 * Should a failed turn be continued automatically, after how long, as which
 * attempt? Pure. `attemptsUsed` counts the automatic continuations already
 * made in this chain (0 after the person's own message or a turn that
 * succeeded). Billing, sign-in and every other error are the person's to see.
 */
export function decideTurnAutoRetry(input: {
  readonly error: string;
  readonly attemptsUsed: number;
}): TurnAutoRetryDecision {
  const notice = classifyTurnError(input.error);
  if (notice.kind === "other") return { retry: false, reason: "not-retryable" };
  if (input.attemptsUsed >= TURN_AUTO_RETRY_MAX_ATTEMPTS) {
    return { retry: false, reason: "attempts-used" };
  }
  const attempt = input.attemptsUsed + 1;
  const delayMs =
    notice.kind === "busy"
      ? notice.retryAfterSeconds * 1_000
      : (NO_ANSWER_RETRY_DELAYS_MS[attempt - 1] ?? NO_ANSWER_RETRY_DELAYS_MS.at(-1)!);
  return {
    retry: true,
    kind: notice.kind,
    attempt,
    maxAttempts: TURN_AUTO_RETRY_MAX_ATTEMPTS,
    delayMs,
  };
}

const AUTO_RETRY_NOTE_OPENING = {
  busy: "Uno AI was busy and your last response was cut off",
  "no-answer": "Uno AI didn't answer and your last response was cut off",
  "agent-stopped": "Your process stopped unexpectedly and your last response was cut off",
} as const;

/**
 * What the daemon sends the agent to continue (after the "(Uno Work) "
 * prefix of secretRequestCopy). A continuation, not the person's message
 * again: the harness has the conversation and the files are on disk, so a
 * resend would invite the agent to start over. Same idea as opencode's own
 * stall retry (OpenCodeAdapter OPENCODE_STALL_RETRY_PROMPT).
 */
export function turnAutoRetryNoteBody(input: {
  readonly kind: AutoRetryKind;
  readonly attempt: number;
  readonly maxAttempts: number;
}): string {
  return `${AUTO_RETRY_NOTE_OPENING[input.kind]} (automatic retry ${input.attempt} of ${input.maxAttempts}). Continue the task from where you stopped; don't repeat finished steps.`;
}

/** The person's words for {@link turnAutoRetryNoteBody}; null for any other text. */
export function turnAutoRetryNoteLine(body: string): string | null {
  const match =
    /^(Uno AI was busy|Uno AI didn't answer|Your process stopped unexpectedly) and your last response was cut off \(automatic retry (\d+) of (\d+)\)/.exec(
      body,
    );
  if (!match) return null;
  const counter = `(${match[2]} of ${match[3]})`;
  if (match[1] === "Uno AI was busy") {
    return `Uno AI was busy — trying again automatically ${counter}…`;
  }
  return match[1] === "Uno AI didn't answer"
    ? `Uno AI didn't answer — trying again automatically ${counter}…`
    : `The agent stopped — trying again automatically ${counter}…`;
}

// ── A turn cut off by a restart ─────────────────────────────────────────

/**
 * The `lastError` the daemon's startup reconciliation stamps on a chat whose
 * agent was working when Uno Work went down (apps/server
 * orchestration/orphanedSession.ts). Here so the client can show it in the
 * person's words ({@link isRestartCutOffError}).
 */
export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

/** The chat's agent was cut off by a restart of Uno Work, not by a failure of its own. */
export function isRestartCutOffError(error: string | null | undefined): boolean {
  return typeof error === "string" && /did not survive a server restart/i.test(error);
}

const UPDATE_RESTART_NOTE_OPENING =
  "Uno Work restarted for an update and your last response was cut off";
const RESTART_NOTE_OPENING = "Uno Work restarted and your last response was cut off";

/**
 * What the daemon sends an agent whose turn an update of Uno Work cut off
 * (after the "(Uno Work) " prefix of secretRequestCopy), once per chat per
 * update. Like {@link turnAutoRetryNoteBody}: a continuation, not the
 * person's message again.
 */
export const UPDATE_RESTART_NOTE_BODY = `${UPDATE_RESTART_NOTE_OPENING}. Continue the task from where you stopped; don't repeat finished steps.`;

/** The same after any other clean restart of the computer's Uno Work. */
export const RESTART_NOTE_BODY = `${RESTART_NOTE_OPENING}. Continue the task from where you stopped; don't repeat finished steps.`;

/** The person's words for those two notes; null for any other text. */
export function updateRestartNoteLine(body: string): string | null {
  if (body.startsWith(UPDATE_RESTART_NOTE_OPENING)) {
    return "Uno Work restarted for an update. The agent goes on where it stopped.";
  }
  return body.startsWith(RESTART_NOTE_OPENING)
    ? "Uno Work restarted. The agent goes on where it stopped."
    : null;
}

// ── Try again ───────────────────────────────────────────────────────────

const TRY_AGAIN_NOTE_OPENING = "The person pressed Try again: your last response failed.";

/**
 * What "Try again" sends: the task once more, as a note. Sending the message
 * again put a copy of it into the chat on every press (qa 01.11). The task
 * travels with the note because the agent may never have seen it: a turn can
 * fail before its first step.
 */
export function tryAgainNoteBody(task: string): string {
  return `${TRY_AGAIN_NOTE_OPENING} Their request:\n\n${task}\n\nDo it now. If part of it is already done, go on from there; don't repeat finished steps.`;
}

/** The person's words for {@link tryAgainNoteBody}; null for any other text. */
export function tryAgainNoteLine(body: string): string | null {
  return body.startsWith(TRY_AGAIN_NOTE_OPENING) ? "Trying again…" : null;
}
