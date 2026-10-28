/**
 * Late-bound bridge from "Join my calls" to economy mode: the economy report
 * (economy/EconomyPresence.ts) asks when to wake the computer for a call and
 * whether a call holds it now. AssistantCallsService registers the source; until
 * then (or without the service) calls neither wake nor hold the computer.
 *
 * @module assistants/callsWake
 */

export interface CallsWake {
  /** Epoch ms to wake the computer at, or null. */
  readonly wakeAt: (nowMs: number) => number | null;
  /** True while a call (or its notes) needs the computer awake. */
  readonly busy: (nowMs: number) => boolean;
}

let source: CallsWake | null = null;

export function setCallsWake(next: CallsWake | null): void {
  source = next;
}

export function callsWake(): CallsWake | null {
  return source;
}

/** The app id the economy report names while calls hold the computer. */
export const CALLS_KEEP_AWAKE = "app:notetaker";
