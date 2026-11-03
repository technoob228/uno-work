/**
 * Computers lifecycle (Misha 02.11, reports/day_2026-11-02/computers-lifecycle/
 * SPEC.md, CONTRACT.md §1): one "Add computer" window from every entry, "What
 * is it for?" after a computer connects, "Bring your work?", one computer menu
 * with Remove / Delete, chats "on MacBook" (brain in the cloud).
 *
 * Server-controlled, off by default: the cloud computer's `computers.state`
 * says `lifecycle` (console flag COMPUTERS_LIFECYCLE_USERS per account, or the
 * daemon's UNO_WORK_COMPUTERS_LIFECYCLE). `ComputersLifecycleSync` (mounted in
 * the root) keeps `useLifecycleFlag` up to date. One device can force it with
 * `localStorage["uno:computers-lifecycle"] = "1"` (or "0").
 *
 * In the demo build (`VITE_DEMO=assist`) it is on unless `?lc=off`; `?lc=fresh`
 * — the MacBook isn't connected yet, `?lc=connected` — it already is a full
 * computer. Kept in this browser: the password page drops the address.
 */
import { create } from "zustand";

import { DEMO_ASSIST } from "../demo/demoFlag";

export type LcStart = "fresh" | "connected" | "off";

export const LC_START_KEY = "demo:lc";
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

/** How the demo starts (always "off" outside it). */
export const LC_START: LcStart = readStart();

function readDeviceOverride(): boolean | null {
  if (DEMO_ASSIST) return LC_START !== "off";
  if (typeof window === "undefined") return null;
  const value = stored(DEVICE_FLAG_KEY);
  return value === "1" ? true : value === "0" ? false : null;
}

interface FlagState {
  /** What the cloud computer said last (false until it answers). */
  readonly server: boolean;
  readonly device: boolean | null;
}

export const useLifecycleFlag = create<FlagState>(() => ({
  server: false,
  device: readDeviceOverride(),
}));

export function setLifecycleServerFlag(server: boolean) {
  if (useLifecycleFlag.getState().server !== server) useLifecycleFlag.setState({ server });
}

const resolve = (state: FlagState) => state.device ?? state.server;

/** For code outside React (store actions). */
export function computersLifecycleOn(): boolean {
  return resolve(useLifecycleFlag.getState());
}

export function useComputersLifecycleOn(): boolean {
  return useLifecycleFlag(resolve);
}

/** After this long without the computer, a waiting chat offers "Continue in the cloud". */
export const CONTINUE_OFFER_MS = DEMO_ASSIST ? 15_000 : 5 * 60_000;
