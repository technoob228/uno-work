/**
 * Multi-computer variants (28.10): the link from the page to each computer.
 * Misha: "computers keep falling off" — the demo has to show a computer that
 * drops and comes back, one that is asleep, and one not reachable at all,
 * through the real socket (the page's own reconnect logic reacts, not a
 * made-up flag).
 *
 * `mac=flaky`: the MacBook's socket closes every ~45 s for ~8 s (first drop
 * ~20 s after the start). `__mcDemo.drop("mac", 10)` drops it on demand (the
 * "what to look at" card and Playwright); `__mcDemo.wake("product")` wakes
 * the asleep Free computer (its account entry turns "running", it answers).
 */
import type { MachineKey } from "../heavyFixtures";
import { WORLD } from "./world";

interface Closable {
  close: (code?: number, reason?: string) => void;
}

const clients = new Map<MachineKey, Set<Closable>>();
/** Until when (ms) a computer's link stays down; 0 = up. */
const downUntil = new Map<MachineKey, number>();
const woken = new Set<MachineKey>();
const listeners = new Set<() => void>();

const FLAKY_FIRST_MS = 20_000;
const FLAKY_EVERY_MS = 45_000;
const FLAKY_DOWN_MS = 8_000;

function notify() {
  for (const listener of listeners) listener();
}

/** Is the computer's link up right now (asleep/offline ones never are). */
export function linkUp(key: MachineKey): boolean {
  if (key === "work") return true;
  if (key === "product") return woken.has("product");
  if (WORLD.account !== "live") return false;
  if (WORLD.mac === "asleep" || WORLD.mac === "offline") return false;
  return (downUntil.get(key) ?? 0) <= Date.now();
}

/** A socket of that computer opened: closed on the next drop. */
export function trackClient(key: MachineKey, client: Closable) {
  let set = clients.get(key);
  if (!set) clients.set(key, (set = new Set()));
  set.add(client);
}

/** Drops the computer's link for `seconds` (its sockets close, reconnects fail until then). */
export function dropLink(key: MachineKey, seconds: number) {
  downUntil.set(key, Date.now() + seconds * 1000);
  const set = clients.get(key);
  if (set) {
    for (const client of set) {
      try {
        client.close(4001, "dropped");
      } catch {
        // already closed
      }
    }
    set.clear();
  }
  notify();
  setTimeout(notify, seconds * 1000 + 50);
}

/** Wakes an asleep cloud computer (the Free one): it answers after a few seconds. */
export function wakeComputer(key: MachineKey, afterSeconds = 4) {
  setTimeout(() => {
    woken.add(key);
    notify();
  }, afterSeconds * 1000);
}

export function isWoken(key: MachineKey): boolean {
  return woken.has(key);
}

export function onLinksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts the flaky MacBook's drops (once). */
let started = false;
export function startLinks() {
  if (started) return;
  started = true;
  if (WORLD.account === "live" && WORLD.mac === "flaky") {
    const tick = () => dropLink("mac", FLAKY_DOWN_MS / 1000);
    setTimeout(() => {
      tick();
      setInterval(tick, FLAKY_EVERY_MS);
    }, FLAKY_FIRST_MS);
  }
  const api = {
    drop: (key: MachineKey, seconds = 10) => dropLink(key, seconds),
    wake: (key: MachineKey, afterSeconds = 4) => wakeComputer(key, afterSeconds),
    up: (key: MachineKey) => linkUp(key),
  };
  (window as unknown as { __mcDemo: typeof api }).__mcDemo = api;
}
