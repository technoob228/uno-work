/**
 * The card in a Uno AI chat (no computer yet) when the request needs one: a
 * bot, a backend, an assistant that stays on.
 *
 * Small is a bare server for the person's own agent: Uno doesn't build there
 * (decision 02.10). The card used to say "This needs your own computer" with
 * only "See plans" to someone who had just paid for Small (live walkthrough
 * 05.10.2026, WG-02) — now it says so plainly and offers both real ways on.
 */
import { CONSOLE_URL } from "../account/accountOverview";
import type { LiteStanding } from "../lite/webLite";

export interface ComputerOfferCopy {
  readonly title: string;
  /** Under the buttons; null keeps the default "this conversation continues there". */
  readonly note: string | null;
  /** The main upgrade button's words. */
  readonly upgradeLabel: string;
  /** "Use my own agent" (Small: the server is for it). */
  readonly ownAgent: boolean;
  /**
   * "Start free — 3 days" and "I have a trial code": only while the console
   * hands out trials (flows wave 1, trial-bot §5 — no promise without a free place).
   */
  readonly trial: boolean;
}

/** Same words as the console's backend when trials are closed. */
export const TRIALS_PAUSED_NOTE = "Free trials are paused right now.";

/**
 * @param trialOpen — `GET /api/v1/public/work-trial` said `available: true`;
 *   false while unknown (loading, error): the card never promises a trial it
 *   can't give.
 */
export function computerOfferCopy(
  standing: LiteStanding | null,
  trialOpen = false,
): ComputerOfferCopy {
  if (standing === "small") {
    return {
      title: "Uno builds this on Plus",
      note: "Your Small server runs what you or your own agent (Claude Code, Codex, Cursor) put on it: Uno doesn't build there. On Plus, Uno builds it for you and this conversation continues there.",
      upgradeLabel: "Upgrade to Plus",
      ownAgent: true,
      trial: false,
    };
  }
  if (!trialOpen && (standing === "free" || standing === null)) {
    return {
      title: "This needs your own computer",
      note: `${TRIALS_PAUSED_NOTE} With Plus, this conversation continues on your computer — Uno there gets everything from here.`,
      upgradeLabel: "Get Plus — $20/mo",
      ownAgent: false,
      trial: false,
    };
  }
  return {
    title: "This needs your own computer",
    note: null,
    upgradeLabel: standing === "other" ? "Upgrade to Plus" : "See plans",
    ownAgent: false,
    trial: trialOpen && standing !== "cloud",
  };
}

/** Public, no sign-in, CORS `*`: does the console hand out the free trial now? */
export const WORK_TRIAL_PUBLIC_URL = `${CONSOLE_URL}/api/v1/public/work-trial`;

export async function fetchWorkTrialOpen(fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher(WORK_TRIAL_PUBLIC_URL, { credentials: "omit" });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as { available?: unknown } | null;
  return body?.available === true;
}

export const workTrialOpenQuery = () => ({
  queryKey: ["uno-work-trial-open"] as const,
  queryFn: () => fetchWorkTrialOpen(),
  staleTime: 30_000,
  retry: false,
});
