/**
 * Boost ×2 for an hour — the words and the timing, kept free of React.
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

export function boostConfirmCopy(boost: UnoComputerBoost) {
  return {
    title: `Boost this computer ×2 for ${boost.hours === 1 ? "1 hour" : `${boost.hours} hours`}?`,
    body:
      `${formatMemory(boost.baseRamMb)} → ${formatMemory(boost.ramMb)} memory and ` +
      `${boost.baseVcpu} → ${cores(boost.vcpu)}. Your computer will restart for a few seconds ` +
      "to switch, and once more when the hour is up. Chats, files and apps come back on their own.",
    allowance: `${boost.hoursLeftToday} of ${boost.hoursPerDay} boost hours left today.`,
    confirm: `Boost for ${boost.hours === 1 ? "1 hour" : `${boost.hours} hours`}`,
  };
}

/** Why the button is greyed out; null when it can be pressed. */
export function boostDisabledReason(boost: UnoComputerBoost): string | null {
  if (boost.available) return null;
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
