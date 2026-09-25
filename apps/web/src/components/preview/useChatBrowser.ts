import { useCallback } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import { useBrowserLiveState } from "./browserLiveStore";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import { makeBrowserSetupFile, makeLiveBrowserFile, usePreviewPane } from "./PreviewPaneContext";

/**
 * «Открыть браузер» для текущего чата. Если агенты чата работают в браузере
 * машины (Work в облаке), открывается он — та же страница, что у агента, а не
 * браузер этого устройства. Иначе — обычная вкладка панели.
 */
export function useChatBrowser(): {
  readonly browsesOnMachine: boolean;
  readonly openChatBrowser: () => void;
} {
  const {
    currentChatEnvironmentId,
    currentChatProjectCwd,
    currentChatThreadId,
    currentProjectKey,
    openFileForTarget,
    openUrl,
  } = usePreviewPane();
  const liveState = useBrowserLiveState(currentChatEnvironmentId);
  const browsesOnMachine = liveState?.agentsBrowseHere === true;

  const openChatBrowser = useCallback(() => {
    if (!browsesOnMachine || !currentChatEnvironmentId) {
      openUrl();
      return;
    }
    const target = { projectKey: currentProjectKey, threadId: currentChatThreadId };
    const existing = liveState?.pages.find(
      (page) => currentChatThreadId !== null && page.context?.threadId === currentChatThreadId,
    );
    if (existing) {
      openFileForTarget(
        target,
        "chat",
        makeLiveBrowserFile({
          environmentId: currentChatEnvironmentId,
          page: existing,
          projectKey: currentProjectKey,
        }),
      );
      return;
    }
    // Новую страницу вкладкой откроет BrowserLiveListener, когда она появится
    // в состоянии машины. Браузер ещё ставится (первое использование) —
    // показываем установку; страница откроется сама.
    const environmentId = currentChatEnvironmentId;
    void readEnvironmentApi(environmentId)
      ?.browserLive.open({
        context: {
          ...(currentChatThreadId ? { threadId: currentChatThreadId } : {}),
          ...(currentChatProjectCwd ? { cwd: currentChatProjectCwd } : {}),
        },
        url: "",
      })
      .then((result) => {
        if (result.pageId !== BROWSER_LIVE_SETUP_PAGE_ID) return;
        openFileForTarget(
          target,
          "chat",
          makeBrowserSetupFile({ environmentId, projectKey: currentProjectKey }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Couldn't open the computer's browser",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  }, [
    browsesOnMachine,
    currentChatEnvironmentId,
    currentChatProjectCwd,
    currentChatThreadId,
    currentProjectKey,
    liveState,
    openFileForTarget,
    openUrl,
  ]);

  return { browsesOnMachine, openChatBrowser };
}
