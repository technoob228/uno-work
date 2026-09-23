/**
 * Navigation state that several parts of the shell share: which mode the
 * sidebar is in (Chats / Files / Apps) and whether an app fills the whole
 * window. The mode is remembered per browser; it is a view preference, not
 * something the computer needs to know.
 */
import { create } from "zustand";

export type SidebarMode = "chats" | "files" | "apps";

export const SIDEBAR_MODES: ReadonlyArray<SidebarMode> = ["chats", "files", "apps"];

const MODE_STORAGE_KEY = "uno:sidebar-mode";

function readMode(): SidebarMode {
  if (typeof window === "undefined") return "chats";
  try {
    const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
    return SIDEBAR_MODES.includes(raw as SidebarMode) ? (raw as SidebarMode) : "chats";
  } catch {
    return "chats";
  }
}

interface NavState {
  readonly sidebarMode: SidebarMode;
  readonly setSidebarMode: (mode: SidebarMode) => void;
  /** The open app covers the whole window (a small pill leads back). */
  readonly appFullscreen: boolean;
  readonly setAppFullscreen: (value: boolean) => void;
}

export const useNavStore = create<NavState>((set) => ({
  sidebarMode: readMode(),
  setSidebarMode: (sidebarMode) => {
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, sidebarMode);
    } catch {
      // private mode: the choice lasts for the session
    }
    set({ sidebarMode });
  },
  appFullscreen: false,
  setAppFullscreen: (appFullscreen) => set({ appFullscreen }),
}));
