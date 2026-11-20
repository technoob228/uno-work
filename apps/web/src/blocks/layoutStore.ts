/**
 * The sidebar's blocks layout on this device (T55 demo). The plan: the layout
 * lives in the Uno account and follows the person to every device; the demo
 * keeps it in localStorage (`uno-work:layout:sidebar:v1`).
 *
 * `editing` and the catalog are view state, not saved. `undo` keeps the
 * layout before the last whole change (a preset, an agent's proposal) so one
 * click brings it back.
 */
import { create } from "zustand";

import {
  DEFAULT_SIDEBAR_LAYOUT,
  normalizeSidebarLayout,
  sidebarLayoutReducer,
  type LayoutAction,
  type SidebarLayout,
} from "./layoutModel";

export const SIDEBAR_LAYOUT_KEY = "uno-work:layout:sidebar:v1";

function readStored(): SidebarLayout {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_LAYOUT;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LAYOUT_KEY);
    return raw ? normalizeSidebarLayout(JSON.parse(raw)) : DEFAULT_SIDEBAR_LAYOUT;
  } catch {
    return DEFAULT_SIDEBAR_LAYOUT;
  }
}

function write(layout: SidebarLayout) {
  try {
    window.localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Private mode: the layout lives until the tab closes.
  }
}

interface LayoutState {
  readonly layout: SidebarLayout;
  readonly editing: boolean;
  readonly catalogOpen: boolean;
  readonly undo: SidebarLayout | null;
  /** Who made the last whole change: the person (a preset) or an agent's chat. */
  readonly changedBy: { readonly kind: "preset" | "agent"; readonly label: string } | null;
  dispatch: (action: LayoutAction) => void;
  /** A whole new layout (a preset, an agent's proposal): the old one kept for Undo. */
  replace: (
    next: SidebarLayout,
    by: { readonly kind: "preset" | "agent"; readonly label: string },
  ) => void;
  undoReplace: () => void;
  setEditing: (editing: boolean) => void;
  setCatalogOpen: (open: boolean) => void;
}

export const useSidebarLayoutStore = create<LayoutState>((set, get) => ({
  layout: readStored(),
  editing: false,
  catalogOpen: false,
  undo: null,
  changedBy: null,
  dispatch: (action) => {
    const layout = sidebarLayoutReducer(get().layout, action);
    write(layout);
    set({ layout });
  },
  replace: (next, by) => {
    const layout = normalizeSidebarLayout(next);
    write(layout);
    set({ undo: get().layout, layout, changedBy: by });
  },
  undoReplace: () => {
    const previous = get().undo;
    if (!previous) return;
    write(previous);
    set({ layout: previous, undo: null, changedBy: null });
  },
  setEditing: (editing) => set({ editing, catalogOpen: editing ? get().catalogOpen : false }),
  setCatalogOpen: (catalogOpen) => set({ catalogOpen }),
}));
