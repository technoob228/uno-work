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
import { boostResetDay, boostsCount, boostsTitle } from "../../account/alwaysOn";
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

/**
 * How boosts read: "boosts" on plans "always on" (one boost = one hour of a
 * boost, counted in pieces: "23 left"), "hours" on the older plans and
 * whenever the account's plan view isn't known.
 */
export type BoostWording = "boosts" | "hours";

function forHours(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function boostConfirmCopy(
  boost: UnoComputerBoost,
  wording: BoostWording = "hours",
  computerName?: string | null,
) {
  if (wording === "boosts") {
    const left = Math.max(0, Math.floor(boost.hoursLeft));
    const after = Math.max(0, left - boost.hours);
    return {
      title: `Boost ${computerName?.trim() || "this computer"} for ${forHours(boost.hours)}?`,
      body:
        `${formatMemory(boost.baseRamMb)} → ${formatMemory(boost.ramMb)}. ` +
        `Uses ${boostsCount(boost.hours)} · ${left} → ${after} left.`,
      allowance: BOOST_START_RESTART_WARNING,
      confirm: `Boost for ${forHours(boost.hours)}`,
    };
  }
  return {
    title: `Boost this computer ×2 for ${forHours(boost.hours)}?`,
    body:
      `${formatMemory(boost.baseRamMb)} → ${formatMemory(boost.ramMb)} memory and ` +
      `${boost.baseVcpu} → ${cores(boost.vcpu)}. ${BOOST_START_RESTART_WARNING}`,
    allowance: boostAllowance(boost),
    confirm: `Boost for ${forHours(boost.hours)}`,
  };
}

/** "Oct 1" — the calendar day the month's hours come back (the reset is 00:00 UTC). */
export { boostResetDay };

/** Whole boost hours economy mode added to this month (already in `hoursLeft`). */
function earnedWholeHours(boost: UnoComputerBoost): number {
  return Math.max(0, Math.floor(boost.hoursEarnedEconomy ?? 0));
}

/** "3 of 10 boost hours left this month." (the 10 includes hours economy earned) */
export function boostAllowance(boost: UnoComputerBoost): string {
  const left = Math.max(0, boost.hoursLeft);
  const total = boost.hoursPerMonth + earnedWholeHours(boost);
  return `${left} of ${total} boost ${total === 1 ? "hour" : "hours"} left this month.`;
}

/** "1.8 h" / "2 h" — hours with at most one decimal. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} h`;
}

/**
 * The quiet line in the computer menu: "Boost: 7 h left this month (+1.8 h
 * earned by economy)", on plans "always on" "⚡ Boosts · 23 left · 13 earned
 * while asleep". Null when the plan has no boost hours (the Boost button
 * already points to plans then).
 */
export function boostSummaryLine(
  boost: UnoComputerBoost | null | undefined,
  wording: BoostWording = "hours",
): string | null {
  if (!boost || boost.hoursPerMonth <= 0) return null;
  if (wording === "boosts") {
    const head = boostsTitle({ left: Math.max(0, Math.floor(boost.hoursLeft)) });
    const earned = earnedWholeHours(boost);
    return earned > 0 ? `${head} · ${earned} earned while asleep` : head;
  }
  const base = `Boost: ${formatHours(Math.max(0, boost.hoursLeft))} left this month`;
  const earned = boost.hoursEarnedEconomy ?? 0;
  return earned > 0 ? `${base} (+${formatHours(earned)} earned by economy)` : base;
}

/**
 * How economy pays back in Boost, for the "How it works" text — from the
 * console's rule (`economy_earn`), never a number of our own: "Every hour
 * asleep earns you 1 extra Boost hour (up to 20 h a month)."; on plans
 * "always on" "Every hour it sleeps earns 1 boost (up to 20 a month)." Null
 * when Uno doesn't reward economy for this account.
 */
export function economyEarnSentence(
  boost: UnoComputerBoost | null | undefined,
  wording: BoostWording = "hours",
): string | null {
  const earn = boost?.economyEarn;
  if (!earn?.enabled || earn.hoursPerSleepHour <= 0 || boost!.hoursPerMonth <= 0) return null;
  const perBoostHour = Math.max(1, Math.round(1 / earn.hoursPerSleepHour));
  if (wording === "boosts") {
    const cap = earn.monthlyCapHours > 0 ? ` (up to ${earn.monthlyCapHours} a month)` : "";
    return perBoostHour === 1
      ? `Every hour it sleeps earns 1 boost${cap}.`
      : `Every ${perBoostHour} hours it sleeps earn 1 boost${cap}.`;
  }
  const cap =
    earn.monthlyCapHours > 0 ? ` (up to ${formatHours(earn.monthlyCapHours)} a month)` : "";
  return perBoostHour === 1
    ? `Every hour asleep earns you 1 extra Boost hour${cap}.`
    : `Every ${perBoostHour} hours asleep earn you 1 extra Boost hour${cap}.`;
}

export const BOOST_NO_HOURS_REASON = "Your plan has no boost hours.";
/** The same on plans "always on" — and the console's own words since 05.10. */
export const BOOST_NO_BOOSTS_REASON = "Your plan has no boosts.";

/** The reason means "a bigger plan has boosts" — the button then points to plans. */
export function isNoBoostsReason(reason: string | null): boolean {
  return reason === BOOST_NO_HOURS_REASON || reason === BOOST_NO_BOOSTS_REASON;
}

/** Why the button is greyed out; null when it can be pressed. */
export function boostDisabledReason(
  boost: UnoComputerBoost,
  wording: BoostWording = "hours",
): string | null {
  if (boost.available) return null;
  const day = boostResetDay(boost.periodResetsAt);
  // The hours come first: they are what the person can do something about.
  if (wording === "boosts") {
    if (boost.hoursPerMonth <= 0) return BOOST_NO_BOOSTS_REASON;
    if (boost.hoursLeft < 1) {
      return day
        ? `No boosts left until ${day}. Every hour a computer sleeps earns one.`
        : "No boosts left this month. Every hour a computer sleeps earns one.";
    }
    return boost.reason ?? "Boost isn't available for this computer right now.";
  }
  if (boost.hoursPerMonth <= 0) return BOOST_NO_HOURS_REASON;
  if (boost.hoursLeft < 1) {
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
