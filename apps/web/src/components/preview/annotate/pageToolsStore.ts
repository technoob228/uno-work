/**
 * Comment mode of each browser tab (by tab id): one mode, like Codex — on,
 * the page takes notes (crosshair, pins) and its console and network show
 * below; off, the page is just the page. No settings (Misha 16.10). In a
 * store, not in the tab's component: the chrome row, the page layer and the
 * drawer read it, and the demo's "Показать" sets it up.
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
  | {
      readonly kind: "new";
      readonly pick: PagePick;
      /** The picture of the picked element, when the browser can take one (it comes a moment later). */
      readonly shot?: Blob;
    }
  | { readonly kind: "edit"; readonly commentId: string };

export interface PageToolsTab {
  /** Comment mode is on: notes on the page, its console and network below. */
  readonly commenting: boolean;
  readonly comments: ReadonlyArray<PageComment>;
  readonly draft: PageCommentDraft | null;
  readonly console: ReadonlyArray<ConsoleEntry>;
  readonly network: ReadonlyArray<NetworkEntry>;
  /** In comment mode: the console/network list is expanded (else just its header row). */
  readonly debugOpen: boolean;
  readonly debugTab: "console" | "network";
}

export const EMPTY_PAGE_TOOLS_TAB: PageToolsTab = {
  commenting: false,
  comments: [],
  draft: null,
  console: [],
  network: [],
  debugOpen: true,
  debugTab: "console",
};

interface PageToolsStore {
  readonly tabs: Readonly<Record<string, PageToolsTab>>;
  /** The errors panel's height (px), dragged by its top edge; one for all tabs. */
  readonly debugHeight: number;
  readonly setDebugHeight: (height: number) => void;
  readonly patch: (tabId: string, patch: Partial<PageToolsTab>) => void;
  /** The one button (and C): comment mode on/off. */
  readonly toggleMode: (tabId: string) => void;
  /** Esc: a note being written goes first, then the mode. */
  readonly escape: (tabId: string) => boolean;
  /** A new document: its console and network start empty (pending comments stay). */
  readonly resetLogs: (tabId: string) => void;
  readonly addConsole: (tabId: string, entry: ConsoleEntry) => void;
  readonly addNetwork: (tabId: string, entry: NetworkEntry) => void;
  readonly saveDraft: (tabId: string, note: string) => void;
  /** The picture of a pick arrived: onto the note being written, or the comment it became. */
  readonly setShot: (tabId: string, pick: PagePick, shot: Blob) => void;
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
    debugHeight: 180,
    setDebugHeight: (height) => set({ debugHeight: Math.round(height) }),
    patch,
    toggleMode: (tabId) => patch(tabId, { commenting: !tab(tabId).commenting, draft: null }),
    escape: (tabId) => {
      const current = tab(tabId);
      if (current.draft) patch(tabId, { draft: null });
      else if (current.commenting) patch(tabId, { commenting: false });
      else return false;
      return true;
    },
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
        ...(draft.shot ? { shot: draft.shot } : {}),
      };
      patch(tabId, { draft: null, comments: [...current.comments, comment] });
    },
    setShot: (tabId, pick, shot) => {
      const current = tab(tabId);
      const draft = current.draft;
      if (draft?.kind === "new" && draft.pick === pick) {
        patch(tabId, { draft: { ...draft, shot } });
        return;
      }
      // Saved before the picture came: the comment keeps the pick's own rect.
      if (!current.comments.some((comment) => comment.docRect === pick.docRect)) return;
      patch(tabId, {
        comments: current.comments.map((comment) =>
          comment.docRect === pick.docRect ? { ...comment, shot } : comment,
        ),
      });
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
