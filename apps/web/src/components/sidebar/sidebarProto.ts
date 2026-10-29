/**
 * Prototype 29.10 (Misha): two ways the sidebar's top could behave, compared
 * in the demo's "what to look at" card.
 *
 *   - `places` — the icon row on top (Home, Files, Apps & sites, …, Dev mode):
 *     `expand` — the hovered icon grows its name, the ones to its right move
 *     over; `one` — one name at a time: the open place's, or the hovered one's;
 *     `tooltip` — as in 0.0.161, the name in a tooltip.
 *   - `peek` — a pinned app with a Home widget: `card` — hover shows its
 *     widget in a small card next to the sidebar; `window` — hover shows the
 *     app itself in a small window (any app, a widget or not); `off` — as in
 *     0.0.161.
 *
 * The first value of each is the recommended one and the default; outside
 * the demo nothing switches. In the demo the page address picks
 * (`?places=one&peek=window`), saved in this browser for the next reload.
 */
import { useSyncExternalStore } from "react";

import { DEMO } from "../../demo/demoFlag";

export type PlacesVariant = "expand" | "one" | "tooltip";
export type PeekVariant = "card" | "window" | "off";

export interface SidebarProto {
  readonly places: PlacesVariant;
  readonly peek: PeekVariant;
}

const DEFAULTS: SidebarProto = { places: "expand", peek: "card" };
const PLACES: ReadonlyArray<PlacesVariant> = ["expand", "one", "tooltip"];
const PEEKS: ReadonlyArray<PeekVariant> = ["card", "window", "off"];
const STORAGE_KEY = "demo:sidebar-proto";

function pick<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

function readInitial(): SidebarProto {
  if (!DEMO || typeof window === "undefined") return DEFAULTS;
  let saved: Partial<SidebarProto> = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<SidebarProto>;
  } catch {
    saved = {};
  }
  const params = new URLSearchParams(window.location.search);
  const next: SidebarProto = {
    places: pick(params.get("places"), PLACES) ?? pick(saved.places, PLACES) ?? DEFAULTS.places,
    peek: pick(params.get("peek"), PEEKS) ?? pick(saved.peek, PEEKS) ?? DEFAULTS.peek,
  };
  persist(next);
  return next;
}

function persist(value: SidebarProto) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A locked-down browser: the switch still works until reload.
  }
}

let current: SidebarProto = readInitial();
const listeners = new Set<() => void>();

export function setSidebarProto(patch: Partial<SidebarProto>): void {
  current = { ...current, ...patch };
  if (DEMO) persist(current);
  // Keep the address in step, so a copied link opens the same variant.
  if (DEMO && typeof window !== "undefined") {
    const url = new URL(window.location.href);
    url.searchParams.set("places", current.places);
    url.searchParams.set("peek", current.peek);
    window.history.replaceState(window.history.state, "", url);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarProto(): SidebarProto {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULTS,
  );
}
