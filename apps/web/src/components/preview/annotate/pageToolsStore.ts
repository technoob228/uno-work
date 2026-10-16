/**
 * Comment and Debug state of each browser tab (by tab id), plus the one
 * per-device switch "Agent sees the console". In a store, not in the tab's
 * component: the chrome row, the page layer and the drawer read it, and the
 * demo's "Показать" sets it up.
 */
import { create } from "zustand";

import type { PagePick } from "./pageToolsScript";
import {
  type ConsoleEntry,
  type NetworkEntry,
  type PageComment,
  pushCapped,
  renumberComments,
} from "./pageTools.logic";

export type PageCommentDraft =
  | { readonly kind: "new"; readonly pick: PagePick }
  | { readonly kind: "edit"; readonly commentId: string };

export interface PageToolsTab {
  readonly commenting: boolean;
  readonly comments: ReadonlyArray<PageComment>;
  readonly draft: PageCommentDraft | null;
  readonly console: ReadonlyArray<ConsoleEntry>;
  readonly network: ReadonlyArray<NetworkEntry>;
  readonly debugOpen: boolean;
  readonly debugTab: "console" | "network";
}

export const EMPTY_PAGE_TOOLS_TAB: PageToolsTab = {
  commenting: false,
  comments: [],
  draft: null,
  console: [],
  network: [],
  debugOpen: false,
  debugTab: "console",
};

const AGENT_SEES_CONSOLE_KEY = "uno:browser-agent-sees-console";

function readAgentSeesConsole(): boolean {
  try {
    return localStorage.getItem(AGENT_SEES_CONSOLE_KEY) !== "0";
  } catch {
    return true;
  }
}

interface PageToolsStore {
  readonly tabs: Readonly<Record<string, PageToolsTab>>;
  /** The agent can read the console of the panel's browser (on by default). */
  readonly agentSeesConsole: boolean;
  /** The errors panel's height (px), dragged by its top edge; one for all tabs. */
  readonly debugHeight: number;
  readonly setDebugHeight: (height: number) => void;
  readonly patch: (tabId: string, patch: Partial<PageToolsTab>) => void;
  readonly setAgentSeesConsole: (on: boolean) => void;
  readonly toggleCommenting: (tabId: string) => void;
  readonly toggleDebug: (tabId: string) => void;
  /** A new document: its console and network start empty (pending comments stay). */
  readonly resetLogs: (tabId: string) => void;
  readonly addConsole: (tabId: string, entry: ConsoleEntry) => void;
  readonly addNetwork: (tabId: string, entry: NetworkEntry) => void;
  readonly saveDraft: (tabId: string, note: string) => void;
  readonly removeComment: (tabId: string, commentId: string) => void;
  readonly clearComments: (tabId: string) => void;
  readonly dropTab: (tabId: string) => void;
}

export const usePageToolsStore = create<PageToolsStore>((set, get) => {
  const tab = (tabId: string) => get().tabs[tabId] ?? EMPTY_PAGE_TOOLS_TAB;
  const patch = (tabId: string, next: Partial<PageToolsTab>) =>
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? EMPTY_PAGE_TOOLS_TAB), ...next } },
    }));
  return {
    tabs: {},
    agentSeesConsole: readAgentSeesConsole(),
    debugHeight: 180,
    setDebugHeight: (height) => set({ debugHeight: Math.round(height) }),
    patch,
    setAgentSeesConsole: (on) => {
      try {
        localStorage.setItem(AGENT_SEES_CONSOLE_KEY, on ? "1" : "0");
      } catch {
        // private mode: just for this session
      }
      set({ agentSeesConsole: on });
    },
    toggleCommenting: (tabId) => patch(tabId, { commenting: !tab(tabId).commenting, draft: null }),
    toggleDebug: (tabId) => patch(tabId, { debugOpen: !tab(tabId).debugOpen }),
    resetLogs: (tabId) => patch(tabId, { console: [], network: [] }),
    addConsole: (tabId, entry) => patch(tabId, { console: pushCapped(tab(tabId).console, entry) }),
    addNetwork: (tabId, entry) => patch(tabId, { network: pushCapped(tab(tabId).network, entry) }),
    saveDraft: (tabId, note) => {
      const current = tab(tabId);
      const draft = current.draft;
      if (!draft) return;
      if (draft.kind === "edit") {
        patch(tabId, {
          draft: null,
          comments: current.comments.map((comment) =>
            comment.id === draft.commentId ? { ...comment, note } : comment,
          ),
        });
        return;
      }
      const pick = draft.pick;
      const comment: PageComment = {
        id: `c-${Date.now().toString(36)}-${current.comments.length + 1}`,
        n: current.comments.length + 1,
        kind: pick.kind,
        selector: pick.selector,
        label: pick.label,
        text: pick.text,
        note,
        docRect: pick.docRect,
      };
      patch(tabId, { draft: null, comments: [...current.comments, comment] });
    },
    removeComment: (tabId, commentId) =>
      patch(tabId, {
        draft: null,
        comments: renumberComments(tab(tabId).comments.filter((c) => c.id !== commentId)),
      }),
    clearComments: (tabId) => patch(tabId, { comments: [], draft: null }),
    dropTab: (tabId) =>
      set((state) => {
        if (!(tabId in state.tabs)) return state;
        const { [tabId]: _dropped, ...rest } = state.tabs;
        return { tabs: rest };
      }),
  };
});

export function usePageToolsTab(tabId: string): PageToolsTab {
  return usePageToolsStore((state) => state.tabs[tabId] ?? EMPTY_PAGE_TOOLS_TAB);
}
