import { useCallback } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import { useBrowserLiveState } from "./browserLiveStore";
import { makeLiveBrowserFile, usePreviewPane } from "./PreviewPaneContext";

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
    // в состоянии машины.
    void readEnvironmentApi(currentChatEnvironmentId)
      ?.browserLive.open({
        context: {
          ...(currentChatThreadId ? { threadId: currentChatThreadId } : {}),
          ...(currentChatProjectCwd ? { cwd: currentChatProjectCwd } : {}),
        },
        url: "",
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
