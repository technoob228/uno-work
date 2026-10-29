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

export type TurnErrorKind = "busy" | "no-answer" | "other";

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
  return { kind: "other", retryAfterSeconds: 0 };
}

// ── Automatic continuation (daemon) ─────────────────────────────────────

/** Automatic continuations per chain of turns; the person's next message starts a new chain. */
export const TURN_AUTO_RETRY_MAX_ATTEMPTS = 2;
/**
 * "Didn't answer": the gateway or the model had a bad moment — a short wait,
 * then a longer one. Index = attempt − 1.
 */
export const NO_ANSWER_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 45_000];

export type TurnAutoRetryDecision =
  | {
      readonly retry: true;
      readonly kind: "busy" | "no-answer";
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
} as const;

/**
 * What the daemon sends the agent to continue (after the "(Uno Work) "
 * prefix of secretRequestCopy). A continuation, not the person's message
 * again: the harness has the conversation and the files are on disk, so a
 * resend would invite the agent to start over. Same idea as opencode's own
 * stall retry (OpenCodeAdapter OPENCODE_STALL_RETRY_PROMPT).
 */
export function turnAutoRetryNoteBody(input: {
  readonly kind: "busy" | "no-answer";
  readonly attempt: number;
  readonly maxAttempts: number;
}): string {
  return `${AUTO_RETRY_NOTE_OPENING[input.kind]} (automatic retry ${input.attempt} of ${input.maxAttempts}). Continue the task from where you stopped; don't repeat finished steps.`;
}

/** The person's words for {@link turnAutoRetryNoteBody}; null for any other text. */
export function turnAutoRetryNoteLine(body: string): string | null {
  const match =
    /^Uno AI (was busy|didn't answer) and your last response was cut off \(automatic retry (\d+) of (\d+)\)/.exec(
      body,
    );
  if (!match) return null;
  const counter = `(${match[2]} of ${match[3]})`;
  return match[1] === "was busy"
    ? `Uno AI was busy — trying again automatically ${counter}…`
    : `Uno AI didn't answer — trying again automatically ${counter}…`;
}
