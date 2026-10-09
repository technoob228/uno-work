/**
 * Demo mode of the real web client (icp3 09.10, "heavy usage" variants):
 * `?demo=heavy` in the address — or a static build with VITE_DEMO=heavy —
 * answers every computer inside the page from fixtures (demoBoot.ts) and
 * shows the variant switcher. Without it nothing here is on and nothing of
 * the demo is loaded: this file is the only part the normal app imports.
 */
import { create } from "zustand";

function readDemo(): boolean {
  if (import.meta.env.VITE_DEMO === "heavy") return true;
  if (typeof location === "undefined") return false;
  try {
    return new URLSearchParams(location.search).get("demo") === "heavy";
  } catch {
    return false;
  }
}

export const DEMO: boolean = readDemo();

/**
 * V1 — Needs you on top of the sidebar; V2 — the Inbox is the Home screen;
 * V3 — coordination (coordinator → helpers); V4 — computers as lanes.
 */
export type DemoVariant = "V1" | "V2" | "V3" | "V4";

export const DEMO_VARIANTS: ReadonlyArray<{ id: DemoVariant; name: string; hint: string }> = [
  {
    id: "V1",
    name: "Needs you on top",
    hint: "The sidebar starts with what waits for you — answer or approve right there. Projects below.",
  },
  {
    id: "V2",
    name: "Inbox is Home",
    hint: "Home is one feed: Needs you → Running → Done today, by project. The sidebar is short.",
  },
  {
    id: "V3",
    name: "Coordination",
    hint: "Coordinators with their helpers on every computer as one tree; the Inbox folds helpers into one card.",
  },
  {
    id: "V4",
    name: "Computer lanes",
    hint: "Home shows a column per computer: what runs where right now.",
  },
];

const KEY = "demo:variant";

function readVariant(): DemoVariant {
  if (typeof location === "undefined" || typeof localStorage === "undefined") return "V1";
  const fromUrl = new URLSearchParams(location.search).get("v")?.toUpperCase();
  const stored = localStorage.getItem(KEY);
  return (
    DEMO_VARIANTS.find((item) => item.id === fromUrl)?.id ??
    DEMO_VARIANTS.find((item) => item.id === stored)?.id ??
    "V1"
  );
}

interface DemoState {
  readonly variant: DemoVariant;
  readonly setVariant: (variant: DemoVariant) => void;
  /** V2: the Home feed narrowed to one project (picked in the sidebar). */
  readonly project: string | null;
  readonly setProject: (project: string | null) => void;
}

export const useDemoStore = create<DemoState>((set) => ({
  variant: DEMO ? readVariant() : "V1",
  setVariant: (variant) => {
    localStorage.setItem(KEY, variant);
    set({ variant, project: null });
  },
  project: null,
  setProject: (project) => set({ project }),
}));

/** The variant on screen; "off" outside the demo. */
export function useDemoVariant(): DemoVariant | "off" {
  const variant = useDemoStore((state) => state.variant);
  return DEMO ? variant : "off";
}

/**
 * What the always-loaded app asks the demo synchronously (set by main.tsx
 * once the demo is loaded; empty outside it).
 */
export const demoHooks: {
  /** V3: fold helpers' Inbox items into one card per coordinator. */
  collapseInbox?: <T extends { open: { kind: string; threadId?: string } | null }>(
    entries: ReadonlyArray<T>,
  ) => ReadonlyArray<T>;
  /** V3: a chat shown in the coordination tree (left out of the plain list). */
  isTeamMember?: (threadId: string) => boolean;
} = {};
