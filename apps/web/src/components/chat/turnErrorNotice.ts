/**
 * How a failed turn is shown in the full Uno Work chat (flows v2, I1).
 *
 * "AI is busy" and "the model didn't answer" are not the person's problem and
 * nothing is lost — so no red: a calm line with "Try again" that resends their
 * last message. Billing stops have their own banner (UnoBillingTopUpBanner).
 *
 * Which errors those are lives in `@t3tools/shared/turnErrorRetry`, shared
 * with the daemon: it continues such a turn by itself (up to two times, no tab
 * needed), so by the time a "busy" or "didn't answer" error reaches this line
 * the automatic retries are already spent and the person decides.
 *
 * A turn cut off by a restart of Uno Work is one plain line too: the agent
 * stopped, nothing failed. After an update the daemon continues such a turn
 * by itself (selfUpdateTurns.ts); after a crash the person's next message does.
 */

export {
  BUSY_DEFAULT_RETRY_SECONDS,
  classifyTurnError,
  isRestartCutOffError,
  type TurnErrorKind,
  type TurnErrorNotice,
} from "@t3tools/shared/turnErrorRetry";

export const TURN_ERROR_COPY = {
  stillBusy: "Uno is still busy. Try again in a minute.",
  noAnswer: "Uno AI didn't answer this time. Nothing is lost.",
  /** Uno Work went down mid-turn (an update, a crash): the agent stopped, nothing else broke. */
  restart: "Stopped by a restart. Send a message to continue.",
  retry: "Try again",
} as const;
