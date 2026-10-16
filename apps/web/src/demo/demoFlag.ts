/**
 * Demo mode of the real web client (w0138 mock, 16.10): `?demo=w0138` in the
 * address — or a static build with VITE_DEMO=w0138 — answers every computer
 * inside the page from fixtures (demoBoot.ts) and shows the "what to look at"
 * panel with the variant switches. Without it nothing here is on and nothing
 * of the demo is loaded: this file is the only part the normal app imports.
 *
 * Real components read the switches through the hooks below; outside the demo
 * every hook answers the production default, so the same code ships in 0.0.138.
 */
import { create } from "zustand";

function readDemo(): boolean {
  if (import.meta.env.VITE_DEMO === "w0138") return true;
  if (typeof location === "undefined") return false;
  try {
    return new URLSearchParams(location.search).get("demo") === "w0138";
  } catch {
    return false;
  }
}

export const DEMO: boolean = readDemo();

/**
 * The switches of the mock: where Misha compares two ways of the same thing.
 * The first value of each is the recommended one and the default.
 */
export interface DemoSwitches {
  /** Which Work this pretends to be: the desktop app on the Mac, or Work on a cloud computer. */
  readonly platform: "desktop" | "cloud";
  /** p3: a full-screen tab folds the chat into a mini window, or into a narrow column. */
  readonly chatDock: "mini" | "column";
  /** p4: tabs live in the chat with pins (A), or in the project like Codex (B). */
  readonly tabs: "pins" | "project";
  /** p5: the sidebar's view is picked from its header (A), or only in Settings (B). */
  readonly sidebarViewSwitch: "header" | "settings";
  /** Pult 4: the Pult is a tab of the right panel (1), or a screen in the middle (2). */
  readonly pult: "panel" | "center";
}

export const DEMO_SWITCH_DEFAULTS: DemoSwitches = {
  platform: "desktop",
  chatDock: "mini",
  tabs: "pins",
  sidebarViewSwitch: "header",
  pult: "panel",
};

export const DEMO_SWITCH_OPTIONS: {
  readonly [K in keyof DemoSwitches]: {
    readonly label: string;
    readonly options: ReadonlyArray<{ readonly id: DemoSwitches[K]; readonly name: string }>;
  };
} = {
  platform: {
    label: "Work runs as",
    options: [
      { id: "desktop", name: "Desktop (Mac)" },
      { id: "cloud", name: "Cloud computer" },
    ],
  },
  chatDock: {
    label: "Full-screen tab · chat folds into",
    options: [
      { id: "mini", name: "Mini window" },
      { id: "column", name: "Narrow column" },
    ],
  },
  tabs: {
    label: "Panel tabs",
    options: [
      { id: "pins", name: "A · Chat + pins" },
      { id: "project", name: "B · Per project" },
    ],
  },
  pult: {
    label: "Пульт",
    options: [
      { id: "panel", name: "1 · Вкладка справа" },
      { id: "center", name: "2 · Экран в центре" },
    ],
  },
  sidebarViewSwitch: {
    label: "Sidebar view picked in",
    options: [
      { id: "header", name: "A · Header menu" },
      { id: "settings", name: "B · Settings" },
    ],
  },
};

const KEY = "demo:switches";

function readSwitches(): DemoSwitches {
  if (typeof localStorage === "undefined") return DEMO_SWITCH_DEFAULTS;
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DemoSwitches>;
    return { ...DEMO_SWITCH_DEFAULTS, ...stored };
  } catch {
    return DEMO_SWITCH_DEFAULTS;
  }
}

interface DemoState {
  readonly switches: DemoSwitches;
  readonly setSwitch: <K extends keyof DemoSwitches>(key: K, value: DemoSwitches[K]) => void;
}

export const useDemoStore = create<DemoState>((set, get) => ({
  switches: DEMO ? readSwitches() : DEMO_SWITCH_DEFAULTS,
  setSwitch: (key, value) => {
    const switches = { ...get().switches, [key]: value };
    localStorage.setItem(KEY, JSON.stringify(switches));
    set({ switches });
  },
}));

/** A switch of the mock; outside the demo always the default (the production behaviour). */
export function useDemoSwitch<K extends keyof DemoSwitches>(key: K): DemoSwitches[K] {
  const value = useDemoStore((state) => state.switches[key]);
  return DEMO ? value : DEMO_SWITCH_DEFAULTS[key];
}

/** Same, outside React. */
export function demoSwitch<K extends keyof DemoSwitches>(key: K): DemoSwitches[K] {
  return DEMO ? useDemoStore.getState().switches[key] : DEMO_SWITCH_DEFAULTS[key];
}

/**
 * The demo pretends to be the desktop app (Misha works in desktop Work on the
 * Mac): places that ask "is this the desktop app?" for a feature ask this too.
 */
export function useDemoDesktop(): boolean {
  return useDemoSwitch("platform") === "desktop" && DEMO;
}

export function demoDesktop(): boolean {
  return DEMO && demoSwitch("platform") === "desktop";
}

/**
 * "Show" buttons of the "what to look at" panel: each point registers a
 * function that puts the interface into the state to look at (opens a chat,
 * the panel, a tab, a menu…). Filled by the code of each point (demo only).
 */
export type DemoShowKey = "p1" | "p2" | "p3" | "p4" | "p5" | "p5b" | "p6" | "p7" | "p8" | "q1" | "q2" | "q3" | "q4" | "q5" | "q6";
export const demoShow: Partial<Record<DemoShowKey, () => void | Promise<void>>> = {};

/** Extra synchronous answers the always-loaded app asks the demo (empty outside it). */
export const demoHooks: Record<string, unknown> = {};
