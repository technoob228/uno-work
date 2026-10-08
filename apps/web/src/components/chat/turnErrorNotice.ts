/**
 * How a failed turn is shown in the full Uno Work chat (flows v2, I1).
 *
 * "AI is busy" and "the model didn't answer" are not the person's problem and
 * nothing is lost — so no red: a calm line with "Try again" that resends their
 * last message. Billing stops have their own banner (UnoBillingTopUpBanner).
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
/** After an automatic retry, the next "busy" within this window is "still busy". */
export const BUSY_AUTO_RETRY_COOLDOWN_MS = 3 * 60_000;

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
  /uno did not answer this time/i,
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

export const TURN_ERROR_COPY = {
  busyCountdown: (seconds: number) =>
    `Uno is busy with your other tasks. Trying again in ${seconds} s…`,
  busyNoRetry: "Uno is busy with your other tasks. Try again in a few seconds.",
  stillBusy: "Uno is still busy. Try again in a minute.",
  noAnswer: "Uno AI didn't answer this time. Nothing is lost.",
  retryNow: "Try again now",
  retry: "Try again",
  retrying: "Trying again…",
} as const;
