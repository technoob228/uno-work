import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useDemoDesktop } from "../../demo/demoFlag";
import { isElectron } from "../../env";
import { useSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import {
  liveBrowserTabId,
  readBrowserLiveState,
  setBrowserOpenError,
  useBrowserLiveState,
} from "./browserLiveStore";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import {
  afterComputerBrowserOpen,
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
    closeFile,
  } = usePreviewPane();
  const liveState = useBrowserLiveState(currentChatEnvironmentId);
  const browsesOnMachine = liveState?.agentsBrowseHere === true;
  const browserOpenIn = useSettings((settings) => settings.browserOpenIn);
  // The demo pretends to be the desktop app on the Mac (its page in an iframe).
  const demoDesktop = useDemoDesktop();
  const sources = useMemo(
    () =>
      availableBrowserSources({
        desktopApp: isElectron || demoDesktop,
        computerBrowser: currentChatEnvironmentId !== null && liveState !== null,
      }),
    [currentChatEnvironmentId, liveState, demoDesktop],
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
      const environmentId = currentChatEnvironmentId;
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Couldn't open the computer's browser",
          description: "This computer isn't connected right now.",
        });
        return;
      }
      // Сразу что-то видимое (стенд 15.10: клик по Browser «ничего не делал»,
      // пока машина запускала браузер): вкладка установки — она же
      // «The browser is ready. Opening the page…», а без браузера — его
      // установка. Страницу откроем сами по ответу машины (или
      // BrowserLiveListener по её появлению), заглушку уберём.
      const setupTabId = liveBrowserTabId(environmentId, BROWSER_LIVE_SETUP_PAGE_ID);
      setBrowserOpenError(environmentId, null);
      if (!existing) {
        openFileForTarget(
          target,
          "chat",
          makeBrowserSetupFile({ environmentId, projectKey: currentProjectKey }),
        );
      }
      setOpen(true);
      void api.browserLive
        .open({
          context: {
            ...(currentChatThreadId ? { threadId: currentChatThreadId } : {}),
            ...(currentChatProjectCwd ? { cwd: currentChatProjectCwd } : {}),
          },
          url,
        })
        .then((result) => {
          const next = afterComputerBrowserOpen({
            resultPageId: result.pageId,
            state: readBrowserLiveState(environmentId),
          });
          if (next.kind === "setup") {
            openFileForTarget(
              target,
              "chat",
              makeBrowserSetupFile({ environmentId, projectKey: currentProjectKey }),
            );
            return;
          }
          if (next.kind === "page") {
            openFileForTarget(
              target,
              "chat",
              makeLiveBrowserFile({
                environmentId,
                page: next.page,
                projectKey: currentProjectKey,
              }),
            );
            closeFile(setupTabId);
          }
          setBrowserOpenError(environmentId, null);
          // "wait": the page isn't in the machine's state yet — the listener
          // opens it when it appears and takes the placeholder away.
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (existing) {
            toastManager.add({
              type: "error",
              title: "Couldn't open the page in the computer's browser",
              description: message,
            });
            return;
          }
          // The tab stays and says so, with Try again (stand 15.10: the tab
          // vanished and only a toast was left for a second).
          setBrowserOpenError(environmentId, message);
        });
    },
    [
      currentChatEnvironmentId,
      currentChatProjectCwd,
      currentChatThreadId,
      currentProjectKey,
      closeFile,
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
