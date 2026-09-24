/**
 * Where an app of the computer opens — always inside Uno first:
 *
 *   - `openHere`   → the main area (`/app`), with Home, "Beside a chat",
 *                    "Full screen" and "New tab" in its bar;
 *   - `openBeside` → the right panel next to the chat you were in last (or next
 *                    to the current screen when there is no chat yet);
 *   - `openInNewTab` → a browser tab, for apps that refuse to be framed or
 *                    can't keep you signed in inside Uno.
 */
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { pickThreadForEnvironmentSwitch } from "../components/Sidebar.logic";
import { makeAppFile, usePreviewPane } from "../components/preview/PreviewPaneContext";
import { useActiveMachine } from "../hooks/useActiveMachine";
import { useSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { isWebLite } from "../lite/flag";
import { useNavStore } from "./navStore";

export interface AppTarget {
  readonly url: string;
  readonly name: string;
  readonly icon?: string | null;
}

export function openInNewTab(url: string): void {
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Web lite has no main area, side panel or computer to open an app beside:
 * every app and site opens in a browser tab. Picked once per build (the flag
 * is a build-time constant), so the hook order never changes.
 */
function useOpenAppInTabs() {
  const open = useCallback((app: AppTarget) => openInNewTab(app.url), []);
  return { openHere: open, openBeside: open, openInNewTab };
}

export const useOpenApp: typeof useOpenAppInApp = isWebLite ? useOpenAppInTabs : useOpenAppInApp;

function useOpenAppInApp() {
  const navigate = useNavigate();
  const preview = usePreviewPane();
  const machine = useActiveMachine();
  const sortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const setAppFullscreen = useNavStore((state) => state.setAppFullscreen);
  const inChat = useMatch({ from: "/_chat/$environmentId/$threadId", shouldThrow: false });

  const openHere = useCallback(
    (app: AppTarget) => {
      setAppFullscreen(false);
      void navigate({
        to: "/app",
        search: { url: app.url, name: app.name, ...(app.icon ? { icon: app.icon } : {}) },
      });
    },
    [navigate, setAppFullscreen],
  );

  const openBeside = useCallback(
    (app: AppTarget) => {
      setAppFullscreen(false);
      const file = makeAppFile(app);
      if (inChat || !machine.environmentId) {
        preview.openAppTab(file);
        return;
      }
      const threads = selectSidebarThreadsForEnvironment(
        useStore.getState(),
        machine.environmentId,
      );
      const last = pickThreadForEnvironmentSwitch(
        threads,
        useUiStateStore.getState().threadLastVisitedAtById,
        sortOrder,
      );
      if (!last) {
        preview.openAppTab(file);
        return;
      }
      preview.queueAppTab(file, last.id);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: machine.environmentId, threadId: last.id }),
      });
    },
    [inChat, machine.environmentId, navigate, preview, setAppFullscreen, sortOrder],
  );

  return { openHere, openBeside, openInNewTab };
}
