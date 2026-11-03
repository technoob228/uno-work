/**
 * Computers lifecycle (Misha 02.11, reports/day_2026-11-02/computers-lifecycle/SPEC.md):
 * one "Add computer" window from every entry, "What is it for?" after a
 * computer connects, "Bring your work?", one computer menu with Remove /
 * Delete, and the secondary "agents on the laptop itself" path.
 *
 * Off outside the demo: production keeps today's screens until the backend
 * parts exist. On in the demo build (`VITE_DEMO=assist`) unless `?lc=off`,
 * or on one device with `localStorage["uno:computers-lifecycle"] = "1"`.
 *
 * The demo's own switches live here too (they are read before the demo
 * boots): `?lc=fresh|connected|off` — the MacBook isn't connected yet, or it
 * already is a full computer; `?fallback=a|b|c` — how the secondary path is
 * shown. Both are kept in this browser: the password page drops the address.
 */
import { DEMO_ASSIST } from "../demo/demoFlag";

export type LcStart = "fresh" | "connected" | "off";
export type FallbackVariant = "a" | "b" | "c";

export const LC_START_KEY = "demo:lc";
export const LC_FALLBACK_KEY = "demo:lc-fallback";
const DEVICE_FLAG_KEY = "uno:computers-lifecycle";

function param(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a locked-down browser: this page only
  }
}

function readStart(): LcStart {
  if (!DEMO_ASSIST || typeof window === "undefined") return "off";
  const asked = param("lc");
  if (asked === "fresh" || asked === "connected" || asked === "off") {
    remember(LC_START_KEY, asked);
    return asked;
  }
  const saved = stored(LC_START_KEY);
  return saved === "connected" || saved === "off" ? saved : "fresh";
}

function readFallback(): FallbackVariant {
  if (typeof window === "undefined") return "a";
  const asked = param("fallback");
  if (asked === "a" || asked === "b" || asked === "c") {
    remember(LC_FALLBACK_KEY, asked);
    return asked;
  }
  const saved = stored(LC_FALLBACK_KEY);
  return saved === "b" || saved === "c" ? saved : "a";
}

/** How the demo starts (always "off" outside it). */
export const LC_START: LcStart = readStart();

export const COMPUTERS_LIFECYCLE: boolean = DEMO_ASSIST
  ? LC_START !== "off"
  : typeof window !== "undefined" && stored(DEVICE_FLAG_KEY) === "1";

/** The secondary path's presentation at the start (the store can change it live). */
export const INITIAL_FALLBACK: FallbackVariant = readFallback();

export function saveFallback(variant: FallbackVariant) {
  remember(LC_FALLBACK_KEY, variant);
}

/** After this long without the computer, a waiting chat offers "Continue in the cloud". */
export const CONTINUE_OFFER_MS = DEMO_ASSIST ? 15_000 : 5 * 60_000;
