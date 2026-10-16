/**
 * Which harnesses were ever signed in with the person's own account in this
 * browser / app — so a chat on Claude that was never signed in says "Sign in
 * to Claude", not "You were signed out of Claude" (flow-agent 15.10: the card
 * met people who had not signed in yet).
 *
 * Learned from the daemon's provider snapshots (`onProvidersUpdated`, which
 * hands over the latest one at once). Kept in localStorage, per driver: a new
 * browser that never saw the sign-in says "Sign in to …" for a lost one too —
 * still true, only less specific.
 *
 * @module components/harness/harnessSignInMemory
 */
import type { ServerProvider } from "@t3tools/contracts";

import { onProvidersUpdated } from "../../rpc/serverState";

const KEY = "uno:harness-ever-signed-in";
const SIGN_IN_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

let known: Set<string> | null = null;

function load(): Set<string> {
  if (known) return known;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    known = new Set(
      Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [],
    );
  } catch {
    known = new Set();
  }
  return known;
}

/** Drivers signed in with the person's own account in these snapshots (not Uno AI's credit). */
export function ownSignedInDrivers(providers: ReadonlyArray<ServerProvider>): string[] {
  return providers
    .filter(
      (provider) =>
        SIGN_IN_DRIVERS.has(provider.driver) &&
        provider.installed &&
        provider.auth.status === "authenticated" &&
        provider.auth.type !== "unoAi",
    )
    .map((provider) => provider.driver);
}

export function rememberSignedIn(providers: ReadonlyArray<ServerProvider>): void {
  const drivers = ownSignedInDrivers(providers);
  if (drivers.length === 0) return;
  const set = load();
  const before = set.size;
  for (const driver of drivers) set.add(driver);
  if (set.size === before) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // private mode: remembered for this page load only
  }
}

/** Ever signed in here. Harnesses without a CLI sign-in: always true (their copy is not about it). */
export function wasEverSignedIn(driver: string): boolean {
  if (!SIGN_IN_DRIVERS.has(driver)) return true;
  return load().has(driver);
}

if (typeof window !== "undefined") {
  onProvidersUpdated((payload) => {
    if (payload) rememberSignedIn(payload.providers);
  });
}
