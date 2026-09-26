/**
 * Economy-mode reconnect gate.
 *
 * An economy computer sleeps when nobody uses it. A browser tab left open
 * would reconnect the moment the socket drops — and a reconnect wakes the
 * computer (the Uno proxy and the wake gateway wake it on any request). So
 * when the computer is asleep or about to sleep and the person is away, the
 * socket URL providers wait here instead of dialing; the person coming back
 * (a click, a key, the tab becoming visible) opens the gate and the reconnect
 * — which wakes the computer in about a second — goes ahead.
 *
 * Keyed by environment ("primary" for the browser's own machine).
 */
export type EconomyGateKey = string;

export const PRIMARY_GATE_KEY: EconomyGateKey = "primary";

interface GateEntry {
  held: boolean;
  waiters: Array<() => void>;
}

const gates = new Map<EconomyGateKey, GateEntry>();
const listeners = new Set<() => void>();

function entry(key: EconomyGateKey): GateEntry {
  let e = gates.get(key);
  if (!e) {
    e = { held: false, waiters: [] };
    gates.set(key, e);
  }
  return e;
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener error must not keep the gate shut.
    }
  }
}

export function holdEconomyGate(key: EconomyGateKey = PRIMARY_GATE_KEY): void {
  const e = entry(key);
  if (e.held) return;
  e.held = true;
  emit();
}

export function releaseEconomyGate(key: EconomyGateKey = PRIMARY_GATE_KEY): void {
  const e = gates.get(key);
  if (!e || !e.held) return;
  e.held = false;
  const waiters = e.waiters.splice(0);
  for (const resolve of waiters) resolve();
  emit();
}

export function isEconomyGateHeld(key: EconomyGateKey = PRIMARY_GATE_KEY): boolean {
  return gates.get(key)?.held ?? false;
}

/** Resolves at once when open; otherwise when the person comes back. */
export function waitEconomyGate(key: EconomyGateKey = PRIMARY_GATE_KEY): Promise<void> {
  const e = gates.get(key);
  if (!e || !e.held) return Promise.resolve();
  return new Promise((resolve) => e.waiters.push(resolve));
}

export function subscribeEconomyGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetEconomyGatesForTests(): void {
  for (const e of gates.values()) {
    for (const resolve of e.waiters.splice(0)) resolve();
  }
  gates.clear();
  listeners.clear();
}
