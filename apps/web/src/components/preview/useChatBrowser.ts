import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { isElectron } from "../../env";
import { useSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { useBrowserLiveState } from "./browserLiveStore";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import {
  availableBrowserSources,
  type BrowserSource,
  resolveBrowserOpenSource,
} from "./browserSource";
import { makeBrowserSetupFile, makeLiveBrowserFile, usePreviewPane } from "./PreviewPaneContext";

/**
 * «Открыть браузер» для текущего чата. Куда — решает человек (чип «Opens in»
 * в адресной строке, `browserOpenIn`), а без его выбора — старое правило: если
 * агенты чата работают в браузере машины (Work в облаке), открывается он — та
 * же страница, что у агента; иначе — обычная вкладка панели.
 */
export function useChatBrowser(): {
  readonly browsesOnMachine: boolean;
  /** The sources this client has for the current chat (the chip shows with 2+). */
  readonly sources: ReadonlyArray<BrowserSource>;
  /** Where "Browser" opens a page now. */
  readonly defaultSource: BrowserSource;
  readonly openChatBrowser: () => void;
  /** Open `url` (or a blank page) in a given source. */
  readonly openInSource: (source: BrowserSource, url?: string) => void;
} {
  const {
    currentChatEnvironmentId,
    currentChatProjectCwd,
    currentChatThreadId,
    currentProjectKey,
    openFileForTarget,
    openUrl,
    setOpen,
  } = usePreviewPane();
  const liveState = useBrowserLiveState(currentChatEnvironmentId);
  const browsesOnMachine = liveState?.agentsBrowseHere === true;
  const browserOpenIn = useSettings((settings) => settings.browserOpenIn);
  const sources = useMemo(
    () =>
      availableBrowserSources({
        desktopApp: isElectron,
        computerBrowser: currentChatEnvironmentId !== null && liveState !== null,
      }),
    [currentChatEnvironmentId, liveState],
  );
  const defaultSource = resolveBrowserOpenSource({
    setting: browserOpenIn,
    sources,
    agentsBrowseOnComputer: browsesOnMachine,
  });

  const openOnComputer = useCallback(
    (url: string) => {
      if (!currentChatEnvironmentId) {
        openUrl(url || undefined);
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
        // The chat has one page on the computer: a new address goes there.
        if (url === "") return;
      }
      // Новую страницу вкладкой откроет BrowserLiveListener, когда она появится
      // в состоянии машины. Браузер ещё ставится (первое использование) —
      // показываем установку; страница откроется сама. Панель открывает человек
      // уже сейчас: иначе вкладка от слушателя (он открывает «как агент») в
      // закрытой им панели легла бы бейджем.
      setOpen(true);
      const environmentId = currentChatEnvironmentId;
      void readEnvironmentApi(environmentId)
        ?.browserLive.open({
          context: {
            ...(currentChatThreadId ? { threadId: currentChatThreadId } : {}),
            ...(currentChatProjectCwd ? { cwd: currentChatProjectCwd } : {}),
          },
          url,
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
    },
    [
      currentChatEnvironmentId,
      currentChatProjectCwd,
      currentChatThreadId,
      currentProjectKey,
      liveState,
      openFileForTarget,
      openUrl,
      setOpen,
    ],
  );

  const openInSource = useCallback(
    (source: BrowserSource, url?: string) => {
      if (source === "computer") {
        openOnComputer(url ?? "");
        return;
      }
      openUrl(url || undefined);
    },
    [openOnComputer, openUrl],
  );

  const openChatBrowser = useCallback(() => {
    openInSource(defaultSource);
  }, [defaultSource, openInSource]);

  return { browsesOnMachine, sources, defaultSource, openChatBrowser, openInSource };
}
