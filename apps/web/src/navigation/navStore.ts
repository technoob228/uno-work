/**
 * Navigation state that several parts of the shell share: which layout the
 * window uses, which section the sidebar shows (Chats / Files / Apps, the
 * Inbox, or Home in the rail), and whether an app fills the whole window.
 * All of it is remembered per browser; it is a view preference, not
 * something the computer needs to know.
 *
 * Layouts (Settings → General → Appearance, behind the Labs flag
 * "Layout options"):
 * - `sidebar` — the standard one: Home, pins, Chats/Files/Apps in one sidebar;
 * - `rail`    — a narrow rail of icons with a panel of the chosen section;
 * - `tabs`    — desktop app only: the standard sidebar plus tabs on top for
 *               the chats, apps and files you have open.
 * Pins, the chosen section and open tabs are shared: switching layouts never
 * loses anything.
 */
import { create } from "zustand";

/** What the sidebar (or the rail's panel) shows. */
export type SidebarMode = "chats" | "files" | "apps" | "inbox" | "home";

/** The three the segmented control of the standard sidebar offers. */
export const SIDEBAR_MODES: ReadonlyArray<SidebarMode> = ["chats", "files", "apps"];

const ALL_MODES: ReadonlyArray<SidebarMode> = ["chats", "files", "apps", "inbox", "home"];

export type NavLayout = "sidebar" | "rail" | "tabs";

export const NAV_LAYOUTS: ReadonlyArray<NavLayout> = ["sidebar", "rail", "tabs"];

const MODE_STORAGE_KEY = "uno:sidebar-mode";
const LAYOUT_STORAGE_KEY = "uno:nav-layout";

function readStored<T extends string>(key: string, allowed: ReadonlyArray<T>, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode: the choice lasts for the session
  }
}

interface NavState {
  readonly sidebarMode: SidebarMode;
  readonly setSidebarMode: (mode: SidebarMode) => void;
  /**
   * The mode the Inbox (or Home panel) was opened from, so "back" in the
   * standard sidebar returns to Chats / Files / Apps as they were.
   */
  readonly lastListMode: SidebarMode;
  /** The chosen layout; `effectiveNavLayout` decides what really shows. */
  readonly layout: NavLayout;
  readonly setLayout: (layout: NavLayout) => void;
  /** The open app covers the whole window (a small pill leads back). */
  readonly appFullscreen: boolean;
  readonly setAppFullscreen: (value: boolean) => void;
  /**
   * "New chat" from outside the sidebar (the rail): the sidebar owns the
   * new-chat logic (which project, which machine) and reacts to the bump.
   */
  readonly newChatRequest: number;
  readonly requestNewChat: () => void;
}

export const useNavStore = create<NavState>((set, get) => {
  const initialMode = readStored(MODE_STORAGE_KEY, ALL_MODES, "chats");
  return {
    sidebarMode: initialMode,
    lastListMode: SIDEBAR_MODES.includes(initialMode) ? initialMode : "chats",
    setSidebarMode: (sidebarMode) => {
      writeStored(MODE_STORAGE_KEY, sidebarMode);
      set({
        sidebarMode,
        lastListMode: SIDEBAR_MODES.includes(sidebarMode) ? sidebarMode : get().lastListMode,
      });
    },
    layout: readStored(LAYOUT_STORAGE_KEY, NAV_LAYOUTS, "sidebar"),
    setLayout: (layout) => {
      writeStored(LAYOUT_STORAGE_KEY, layout);
      set({ layout });
    },
    appFullscreen: false,
    setAppFullscreen: (appFullscreen) => set({ appFullscreen }),
    newChatRequest: 0,
    requestNewChat: () => set({ newChatRequest: get().newChatRequest + 1 }),
  };
});

/**
 * What the window really shows. The alternative layouts are Labs-only (off →
 * the standard sidebar, whatever was chosen), the rail needs a wide window
 * (phones keep the standard sheet), and tabs are for the desktop app.
 */
export function effectiveNavLayout(input: {
  readonly chosen: NavLayout;
  readonly labsEnabled: boolean;
  readonly isMobile: boolean;
  readonly isDesktopApp: boolean;
}): NavLayout {
  if (!input.labsEnabled || input.isMobile) return "sidebar";
  if (input.chosen === "tabs" && !input.isDesktopApp) return "sidebar";
  return input.chosen;
}
