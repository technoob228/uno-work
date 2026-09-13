import { useSyncExternalStore } from "react";

/**
 * A shared wall clock that ticks once a minute. Time-derived UI (snooze
 * expiry, "settled after N days idle", "wakes in 3h" labels) reads it so a
 * snoozed chat reappears on its own without any server event. One interval
 * serves every subscriber and stops when the last one unmounts.
 */
const TICK_MS = 60_000;

let currentIso = new Date().toISOString();
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    currentIso = new Date().toISOString();
    interval = setInterval(() => {
      currentIso = new Date().toISOString();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

function getSnapshot(): string {
  return currentIso;
}

/** Current time as an ISO string, refreshed every minute. */
export function useMinuteClock(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Force the shared clock forward now (e.g. right after snoozing, so an
    already-expired wake time is reflected without waiting a minute). */
export function refreshMinuteClock(): void {
  currentIso = new Date().toISOString();
  for (const notify of listeners) notify();
}
