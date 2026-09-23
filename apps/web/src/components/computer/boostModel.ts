/**
 * Boost ×2 for an hour — the words and the timing, kept free of React.
 * A boost spends the plan's boost hours for the month (counted per account).
 *
 * The computer restarts into the boost and back, and this screen may be
 * served from that very computer: the answer to "boost" can be lost with the
 * connection. So the screen shows what it asked for ("Restarting into
 * boost…") until the computer's own state agrees, and only a clear refusal
 * from Uno turns into an error.
 */
import type { UnoComputerBoost, UnoComputerBoostState } from "@t3tools/contracts";

import {
  TransportConnectionLostError,
  isTransportConnectionErrorMessage,
  isTransportInterruptErrorMessage,
} from "../../rpc/transportError";
import { formatMemory } from "./computerFormat";

/** How often the computer's state is read while a boost is switching. */
export const BOOST_SWITCHING_REFETCH_MS = 3_000;
/** After this long without the computer agreeing, trust what it says. */
export const BOOST_OPTIMISTIC_MAX_MS = 3 * 60_000;
/**
 * After a lost connection, a fresh read this long after the drop that still
 * says "off" means the boost did not start (the restart would have shown).
 */
export const BOOST_DROP_SETTLE_MS = 8_000;

/** What the person asked for and hasn't seen confirmed yet. */
export interface BoostPending {
  readonly kind: "start" | "end";
  readonly at: number;
  /** When the answer was lost with the connection. */
  readonly droppedAt: number | null;
}

/** The state to show: the computer's, or the one just asked for. */
export function shownBoostState(
  boost: UnoComputerBoost,
  pending: BoostPending | null,
): UnoComputerBoostState {
  if (pending?.kind === "start" && boost.state === "off") return "starting";
  if (pending?.kind === "end" && boost.state === "active") return "ending";
  return boost.state;
}

/** Has the computer caught up with what was asked (or is it time to stop waiting)? */
export function pendingSettled(
  pending: BoostPending,
  boost: UnoComputerBoost,
  now: number,
): boolean {
  if (now - pending.at > BOOST_OPTIMISTIC_MAX_MS) return true;
  return pending.kind === "start" ? boost.state !== "off" : boost.state !== "active";
}

/** The answer was lost because the computer (and this screen's daemon) restarted. */
export function isConnectionDrop(error: unknown): boolean {
  if (error instanceof TransportConnectionLostError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return isTransportConnectionErrorMessage(message) || isTransportInterruptErrorMessage(message);
}

export function minutesLeft(endsAt: string | null, now: number): number | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / 60_000));
}

/** "Boosted ×2 · 43 min left", "Restarting into boost…", "Returning to normal size…". */
export function boostPillLabel(
  state: UnoComputerBoostState,
  endsAt: string | null,
  now: number,
): string {
  if (state === "starting") return "Restarting into boost…";
  if (state === "ending") return "Returning to normal size…";
  const left = minutesLeft(endsAt, now);
  if (left === null) return "Boosted ×2";
  if (left === 0) return "Returning to normal size…";
  if (left === 1) return "Boosted ×2 · 1 min left";
  return `Boosted ×2 · ${left} min left`;
}

function cores(n: number): string {
  return `${n} ${n === 1 ? "core" : "cores"}`;
}

/** What ending a boost early costs: one restart, right now. */
export const BOOST_RESTART_WARNING =
  "Your computer restarts for about 15 seconds. A reply the AI is writing right now will stop; " +
  "chats, files and apps come back on their own.";

/** Starting a boost costs two restarts: now, and again when the boost hour runs out. */
export const BOOST_START_RESTART_WARNING =
  "Your computer restarts for about 15 seconds now and again when the hour ends. " +
  "A reply the AI is writing at that moment will stop; chats, files and apps come back on their own.";

export function boostConfirmCopy(boost: UnoComputerBoost) {
  return {
    title: `Boost this computer ×2 for ${boost.hours === 1 ? "1 hour" : `${boost.hours} hours`}?`,
    body:
      `${formatMemory(boost.baseRamMb)} → ${formatMemory(boost.ramMb)} memory and ` +
      `${boost.baseVcpu} → ${cores(boost.vcpu)}. ${BOOST_START_RESTART_WARNING}`,
    allowance: boostAllowance(boost),
    confirm: `Boost for ${boost.hours === 1 ? "1 hour" : `${boost.hours} hours`}`,
  };
}

/** "Oct 1" — the calendar day the month's hours come back (the reset is 00:00 UTC). */
export function boostResetDay(periodResetsAt: string | null): string | null {
  if (!periodResetsAt) return null;
  const at = Date.parse(periodResetsAt);
  if (Number.isNaN(at)) return null;
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "3 of 10 boost hours left this month." */
export function boostAllowance(boost: UnoComputerBoost): string {
  const left = Math.max(0, boost.hoursLeft);
  return `${left} of ${boost.hoursPerMonth} boost ${boost.hoursPerMonth === 1 ? "hour" : "hours"} left this month.`;
}

export const BOOST_NO_HOURS_REASON = "Your plan has no boost hours.";

/** Why the button is greyed out; null when it can be pressed. */
export function boostDisabledReason(boost: UnoComputerBoost): string | null {
  if (boost.available) return null;
  // The hours come first: they are what the person can do something about.
  if (boost.hoursPerMonth <= 0) return BOOST_NO_HOURS_REASON;
  if (boost.hoursLeft < 1) {
    const day = boostResetDay(boost.periodResetsAt);
    return day ? `Boost hours are used up until ${day}.` : "This month's boost hours are used up.";
  }
  return boost.reason ?? "Boost isn't available for this computer right now.";
}

/** Read the computer's state more often while a boost is switching or about to end. */
export function boostRefetchMs(
  boost: UnoComputerBoost | undefined,
  now: number,
  idleMs: number,
): number {
  if (!boost) return idleMs;
  if (boost.state === "starting" || boost.state === "ending") return BOOST_SWITCHING_REFETCH_MS;
  if (boost.state === "active") {
    const left = minutesLeft(boost.endsAt, now);
    if (left !== null && left <= 1) return BOOST_SWITCHING_REFETCH_MS;
  }
  return idleMs;
}
