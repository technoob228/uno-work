import { create } from "zustand";

import { openNewProject } from "./navigation/newProjectStore";

interface CommandPaletteOpenIntent {
  /** add-project: the add-project flow. new-thread-in: the "New chat in..." project picker. */
  kind: "add-project" | "new-thread-in";
  requestId: number;
}

interface CommandPaletteStore {
  open: boolean;
  openIntent: CommandPaletteOpenIntent | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  /**
   * "New project" everywhere in the main UI: the New project dialog (folder
   * in home / empty / GitHub). The old T3 add-project palette flow is
   * `openLegacyAddProject`, kept for the Labs legacy sidebar only.
   */
  openAddProject: () => void;
  openLegacyAddProject: () => void;
  openNewThreadIn: () => void;
  clearOpenIntent: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  openIntent: null,
  setOpen: (open) => set({ open, ...(open ? {} : { openIntent: null }) }),
  toggleOpen: () =>
    set((state) => ({ open: !state.open, ...(state.open ? { openIntent: null } : {}) })),
  openAddProject: () => openNewProject(),
  openLegacyAddProject: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "add-project",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  openNewThreadIn: () =>
    set((state) => ({
      open: true,
      openIntent: {
        kind: "new-thread-in",
        requestId: (state.openIntent?.requestId ?? 0) + 1,
      },
    })),
  clearOpenIntent: () => set({ openIntent: null }),
}));
