/**
 * Demo mode of the real web client (w0138 mock, 16.10): `?demo=w0138` in the
 * address of the dev server — or a static build with VITE_DEMO=w0138 — answers every computer
 * inside the page from fixtures (demoBoot.ts) and shows the "what to look at"
 * panel with the variant switches. Without it nothing here is on and nothing
 * of the demo is loaded: this file is the only part the normal app imports.
 *
 * Real components read the switches through the hooks below; outside the demo
 * every hook answers the production default, so the same code ships in 0.0.138.
 */
import { create } from "zustand";

/**
 * Which demo: `w0138` — the 16.10 mock (its own assistants prototype in this
 * browser); `assist` — the assistants base (28.10): every assistant screen is
 * the real one, its daemon answered by `demo/assist/*` (README_DEMO.md).
 */
export type DemoMode = "w0138" | "assist";
const DEMO_MODES: ReadonlySet<string> = new Set(["w0138", "assist"]);

function readDemoMode(): DemoMode | null {
  const built = import.meta.env.VITE_DEMO;
  if (built && DEMO_MODES.has(built)) return built as DemoMode;
  // `?demo=` only on the dev server: in a real build the link must not swap
  // the person's saved computers for demo ones (demoBoot clears storage).
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  try {
    const asked = new URLSearchParams(location.search).get("demo");
    return asked && DEMO_MODES.has(asked) ? (asked as DemoMode) : null;
  } catch {
    return null;
  }
}

export const DEMO_MODE: DemoMode | null = readDemoMode();
export const DEMO: boolean = DEMO_MODE !== null;
/** The 16.10 mock: assistants from the prototype store, not from a daemon. */
export const DEMO_PROTOTYPE: boolean = DEMO_MODE === "w0138";
/** The assistants base: real assistant screens, fake daemons (demo/assist). */
export const DEMO_ASSIST: boolean = DEMO_MODE === "assist";
/**
 * Variant C of the assistants (28.10, branch demo/assistants-c-1028): one Uno
 * on the account (on the cloud computer that stays on), Uno works on every
 * computer without a setup there, and your own assistants live under Uno —
 * it hands them tasks and their reports come through it. The real components
 * read this to show the variant; off everywhere outside the assistants demo.
 */
export const VARIANT_C: boolean = DEMO_ASSIST;

/**
 * The switches of the mock: where Misha compares two ways of the same thing.
 * The first value of each is the recommended one and the default.
 */
export interface DemoSwitches {
  /** Which Work this pretends to be: the desktop app on the Mac, or Work on a cloud computer. */
  readonly platform: "desktop" | "cloud";
  /** p3: a full-screen tab folds the chat into a mini window, or into a narrow column. */
  readonly chatDock: "mini" | "column";
  /** p4: a tab group's label (click collapses the group) is a small icon, or its name. */
  readonly tabGroupIcons: "icon" | "plain";
  /** p4: what the person opens in a chat lands in the Project group (stays across its chats) or in the chat's. */
  readonly newTabsGo: "project" | "chat";
  /** p5: the sidebar's view is picked from its header (A), or only in Settings (B). */
  readonly sidebarViewSwitch: "header" | "settings";
  /** p9: the apps as they are (GitHub and Drive connected), or nothing connected yet. */
  readonly connectors: "connected" | "empty";
}

export const DEMO_SWITCH_DEFAULTS: DemoSwitches = {
  platform: "cloud",
  chatDock: "mini",
  tabGroupIcons: "icon",
  newTabsGo: "chat",
  sidebarViewSwitch: "header",
  connectors: "connected",
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
  tabGroupIcons: {
    label: "Group label",
    options: [
      { id: "icon", name: "Icon" },
      { id: "plain", name: "Name" },
    ],
  },
  newTabsGo: {
    label: "What you open goes to",
    options: [
      { id: "chat", name: "This chat" },
      { id: "project", name: "Project" },
    ],
  },
  sidebarViewSwitch: {
    label: "Sidebar view picked in",
    options: [
      { id: "header", name: "A · Header menu" },
      { id: "settings", name: "B · Settings" },
    ],
  },
  connectors: {
    label: "Connectors",
    options: [
      { id: "connected", name: "GitHub + Drive connected" },
      { id: "empty", name: "Nothing connected" },
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
export type DemoShowKey =
  | "p1"
  | "p2"
  | "p2b"
  | "p3"
  | "p4"
  | "p5"
  | "p5b"
  | "p6"
  | "p7"
  | "p8"
  | "p9";
export const demoShow: Partial<Record<DemoShowKey, () => void | Promise<void>>> = {};

/** Extra synchronous answers the always-loaded app asks the demo (empty outside it). */
export const demoHooks: Record<string, unknown> = {};
