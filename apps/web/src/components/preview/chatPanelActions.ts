/**
 * What the chat on screen lets the right panel's launcher open that is not a
 * panel tab: the terminal drawer and the Changes (diff) panel. Both belong to
 * ChatView (its terminal state, its route's `?diff=1`), while the launcher
 * lives in PreviewPane outside it — so the main chat publishes its actions
 * here and takes them back when it leaves. `null` for an action: it makes no
 * sense in this chat (no project for a terminal, not a git project for
 * Changes) — the launcher hides the tile rather than showing it off.
 */
import { create } from "zustand";

export interface ChatPanelActions {
  readonly threadId: string;
  readonly openTerminal: (() => void) | null;
  readonly openChanges: (() => void) | null;
}

interface ChatPanelActionsStore {
  readonly actions: ChatPanelActions | null;
  readonly publish: (actions: ChatPanelActions) => void;
  /** The chat left the screen: only its own actions are taken back. */
  readonly withdraw: (threadId: string) => void;
}

export const useChatPanelActionsStore = create<ChatPanelActionsStore>((set) => ({
  actions: null,
  publish: (actions) => set({ actions }),
  withdraw: (threadId) =>
    set((state) => (state.actions?.threadId === threadId ? { actions: null } : state)),
}));

/** The actions of the chat on screen, or null outside a chat (or for another chat). */
export function useChatPanelActions(currentThreadId: string | null): ChatPanelActions | null {
  return useChatPanelActionsStore((state) =>
    state.actions && currentThreadId !== null && state.actions.threadId === currentThreadId
      ? state.actions
      : null,
  );
}
