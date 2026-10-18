/**
 * Files in the right panel (Misha 18.10): in a chat, Files in the sidebar (and
 * the panel's own Files tile) opens the computer's files as a tab of the
 * panel, beside the chat, so the chat stays put. The tab's full-screen button
 * gives it the whole window; "Open in Files" in its menu leaves the chat for
 * the Files screen. Outside a chat (Home, Apps…) Files opens as a screen, as
 * before.
 *
 * The folder the tab shows lives here, not in the URL (the URL is the chat's),
 * so switching tabs or chats keeps the place.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMatch } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { create } from "zustand";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { makeFilesTabFile, usePreviewPane } from "../preview/PreviewPaneContext";
import type { FilesRouteSearch } from "./filesRouteSearch";

interface PanelFilesState {
  /** Tab id → the place in Files it shows. */
  readonly byTab: Readonly<Record<string, FilesRouteSearch>>;
  readonly setPlace: (tabId: string, place: FilesRouteSearch) => void;
}

export const usePanelFilesStore = create<PanelFilesState>((set) => ({
  byTab: {},
  setPlace: (tabId, place) => set((state) => ({ byTab: { ...state.byTab, [tabId]: place } })),
}));

const HOME: FilesRouteSearch = {};

/** The place a Files tab shows (the home folder until the person moves). */
export function usePanelFilesPlace(tabId: string): FilesRouteSearch {
  return usePanelFilesStore((state) => state.byTab[tabId] ?? HOME);
}

/** Where Files opens when the person asks for it. */
export function filesOpensInPanel(input: {
  readonly inChat: boolean;
  readonly isMobile: boolean;
  readonly hasEnvironment: boolean;
}): boolean {
  // A phone has no room for the chat and the panel side by side.
  return input.inChat && !input.isMobile && input.hasEnvironment;
}

/**
 * Opens (or focuses) the Files tab of the chat's computer, in the Everywhere
 * group like the files picked in it. A tab seen for the first time starts in
 * `startFolder` (the home folder without it); one already used keeps its place. Returns false when Files isn't for the panel
 * here (not in a chat, a phone) — then the caller opens the Files screen.
 */
export function useOpenFilesInPanel(isMobile: boolean): (startFolder?: string | null) => boolean {
  const preview = usePreviewPane();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const inChat = useMatch({ from: "/_chat/$environmentId/$threadId", shouldThrow: false });
  const latest = useRef({ preview, activeEnvironmentId, inChat, isMobile });
  latest.current = { preview, activeEnvironmentId, inChat, isMobile };
  return useCallback((startFolder?: string | null) => {
    const {
      preview: pane,
      activeEnvironmentId: active,
      inChat: chat,
      isMobile: phone,
    } = latest.current;
    const environmentId: EnvironmentId | null = pane.currentChatEnvironmentId ?? active;
    if (
      !filesOpensInPanel({
        inChat: Boolean(chat),
        isMobile: phone,
        hasEnvironment: !!environmentId,
      })
    ) {
      return false;
    }
    if (!environmentId) return false;
    const tab = makeFilesTabFile(environmentId);
    const store = usePanelFilesStore.getState();
    if (startFolder && !store.byTab[tab.id]) store.setPlace(tab.id, { path: startFolder });
    pane.openFileForTarget(
      { projectKey: pane.currentProjectKey, threadId: pane.currentChatThreadId },
      "global",
      tab,
    );
    return true;
  }, []);
}
