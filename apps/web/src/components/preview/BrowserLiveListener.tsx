import { useEffect, useRef, useState } from "react";
import type { BrowserLiveSetupStatus, BrowserLiveState, EnvironmentId } from "@t3tools/contracts";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../store";
import { liveBrowserTabId, liveBrowserTabName, setBrowserLiveState } from "./browserLiveStore";
import { resolveBridgeEventProjectKey } from "./browserBridgeRouting";
import {
  findTabScopeKey,
  makeBrowserSetupFile,
  makeLiveBrowserFile,
  usePreviewPane,
} from "./PreviewPaneContext";

/**
 * Невидимый слушатель браузеров машин (`subscribeBrowserLive`) всех
 * подключённых окружений.
 *
 * Вкладка страницы открывается в чате-источнике, когда агент открыл страницу
 * или позвал человека (`attention` вырос), — а вкладку, которую человек
 * закрыл, без нового повода не навязываем. Страницы, открытые до подключения,
 * тоже не всплывают — кроме тех, где агент ждёт человека.
 */
export function BrowserLiveListener() {
  const { openFileForTarget, updateBrowserTab, closeFile, statesByScopeKey, currentProjectKey } =
    usePreviewPane();
  const groupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));

  const openRef = useRef(openFileForTarget);
  openRef.current = openFileForTarget;
  const updateRef = useRef(updateBrowserTab);
  updateRef.current = updateBrowserTab;
  const closeRef = useRef(closeFile);
  closeRef.current = closeFile;
  const statesRef = useRef(statesByScopeKey);
  statesRef.current = statesByScopeKey;
  const currentProjectKeyRef = useRef(currentProjectKey);
  currentProjectKeyRef.current = currentProjectKey;
  const groupingSettingsRef = useRef(groupingSettings);
  groupingSettingsRef.current = groupingSettings;

  const [connectionsVersion, setConnectionsVersion] = useState(0);
  useEffect(
    () => subscribeEnvironmentConnections(() => setConnectionsVersion((value) => value + 1)),
    [],
  );

  useEffect(() => {
    const unsubscribers = listEnvironmentConnections().map((connection) => {
      const environmentId = connection.environmentId;
      const api = readEnvironmentApi(environmentId);
      if (!api) return undefined;
      // attention, которое мы уже видели, по странице. null = первый снимок.
      let seen: Map<string, number> | null = null;
      let setupStatus: BrowserLiveSetupStatus | null = null;

      const apply = (state: BrowserLiveState) => {
        setBrowserLiveState(environmentId, state);
        const first = seen === null;

        // Браузер машины ставится при первом использовании. Установку начал
        // агент — показываем прогресс в его чате; встал — вкладка установки
        // уходит (страницу, которую ждал человек, машина откроет сама).
        const setupTabId = liveBrowserTabId(environmentId, BROWSER_LIVE_SETUP_PAGE_ID);
        const previousSetup = setupStatus;
        setupStatus = state.setup.status;
        if (state.setup.status === "ready") {
          if (findTabScopeKey(statesRef.current, setupTabId)) closeRef.current(setupTabId);
        } else if (
          !first &&
          previousSetup !== state.setup.status &&
          (state.setup.status === "installing" || state.setup.status === "failed") &&
          state.setup.context &&
          !findTabScopeKey(statesRef.current, setupTabId)
        ) {
          const projectKey =
            resolveBridgeEventProjectKey({
              context: state.setup.context,
              environmentId,
              state: useStore.getState(),
              groupingSettings: groupingSettingsRef.current,
            }) ?? currentProjectKeyRef.current;
          openRef.current(
            { projectKey, threadId: state.setup.context.threadId ?? null },
            "chat",
            makeBrowserSetupFile({ environmentId, projectKey }),
          );
        }
        const previous = seen ?? new Map<string, number>();
        const next = new Map<string, number>();

        for (const page of state.pages) {
          next.set(page.pageId, page.attention);
          const tabId = liveBrowserTabId(environmentId, page.pageId);
          const known = previous.get(page.pageId);
          const bumped = first
            ? page.help !== null
            : known === undefined
              ? page.attention > 0
              : page.attention > known;

          // Имя и адрес открытой вкладки следуют за страницей.
          const scopeKey = findTabScopeKey(statesRef.current, tabId);
          if (scopeKey) {
            const tab = statesRef.current[scopeKey]?.files.find(
              (candidate) => candidate.id === tabId,
            );
            const name = liveBrowserTabName(page);
            if (tab && (tab.name !== name || tab.url !== page.url)) {
              updateRef.current(scopeKey, tabId, { name, url: page.url });
            }
          }
          if (!bumped) continue;

          const projectKey =
            resolveBridgeEventProjectKey({
              context: page.context,
              environmentId,
              state: useStore.getState(),
              groupingSettings: groupingSettingsRef.current,
            }) ?? currentProjectKeyRef.current;
          openRef.current(
            { projectKey, threadId: page.context?.threadId ?? null },
            "chat",
            makeLiveBrowserFile({ environmentId, page, projectKey }),
          );
        }

        // Страница закрылась на машине (сайт закрыл попап, браузер перезапущен)
        // — её вкладке больше нечего показывать.
        for (const pageId of previous.keys()) {
          if (next.has(pageId)) continue;
          const tabId = liveBrowserTabId(environmentId, pageId);
          if (findTabScopeKey(statesRef.current, tabId)) closeRef.current(tabId);
        }
        seen = next;
      };

      const unsubscribe = api.browserLive.subscribe(apply);
      return () => {
        unsubscribe();
        setBrowserLiveState(environmentId as EnvironmentId, null);
      };
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [connectionsVersion]);

  return null;
}
