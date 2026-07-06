import { useEffect, useRef, useState } from "react";
import type { BrowserBridgeCommandEvent } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../store";
import { runBrowserAutomationCommandForProject } from "./BrowserAutomationRegistry";
import { resolveBridgeEventProjectKey } from "./browserBridgeRouting";
import { usePreviewPane } from "./PreviewPaneContext";

function resolveResultUrl(resultUrl: string): string {
  if (/^https?:\/\//i.test(resultUrl)) return resultUrl;
  return `${window.location.origin}${resultUrl.startsWith("/") ? "" : "/"}${resultUrl}`;
}

async function postCommandResult(
  event: BrowserBridgeCommandEvent,
  result: { ok: boolean; data?: unknown; error?: string },
): Promise<void> {
  await fetch(resolveResultUrl(event.resultUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commandId: event.commandId,
      responseToken: event.responseToken,
      ok: result.ok,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    }),
  }).catch(() => undefined);
}

/**
 * Невидимый слушатель команд «открой URL в браузере приложения»:
 *
 * 1. WS-подписки на bridge-события ВСЕХ подключённых окружений. Событие несёт
 *    контекст запроса (threadId/cwd харнесса) — по нему вкладка открывается и
 *    команды исполняются в проекте-источнике, а не в том, что сейчас на
 *    экране. Без контекста — fallback на текущий проект (легаси-токены).
 * 2. Пуш от Electron main-процесса — target=_blank/window.open изнутри
 *    webview превращается в новую браузерную вкладку.
 */
export function BrowserBridgeListener() {
  const { openUrl, openUrlInProject, currentProjectKey } = usePreviewPane();
  const browserAutomationLevel = useSettings((settings) => settings.browserAutomationLevel);
  const groupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));

  // Меняющиеся значения — через ref, чтобы не пересоздавать WS-подписки при
  // каждом переключении проекта или правке настроек.
  const currentProjectKeyRef = useRef(currentProjectKey);
  currentProjectKeyRef.current = currentProjectKey;
  const groupingSettingsRef = useRef(groupingSettings);
  groupingSettingsRef.current = groupingSettings;
  const automationLevelRef = useRef(browserAutomationLevel);
  automationLevelRef.current = browserAutomationLevel;
  const openUrlInProjectRef = useRef(openUrlInProject);
  openUrlInProjectRef.current = openUrlInProject;

  const [connectionsVersion, setConnectionsVersion] = useState(0);
  useEffect(
    () => subscribeEnvironmentConnections(() => setConnectionsVersion((value) => value + 1)),
    [],
  );

  useEffect(() => {
    const unsubscribers = listEnvironmentConnections().map((connection) => {
      const api = readEnvironmentApi(connection.environmentId);
      if (!api) return undefined;
      return api.browser.subscribeBridge((event) => {
        const projectKey =
          resolveBridgeEventProjectKey({
            context: event.context,
            environmentId: connection.environmentId,
            state: useStore.getState(),
            groupingSettings: groupingSettingsRef.current,
          }) ?? currentProjectKeyRef.current;

        if (event.type === "openUrl") {
          openUrlInProjectRef.current(projectKey, event.url);
          return;
        }
        void (async () => {
          try {
            const automationLevel = automationLevelRef.current;
            if (automationLevel === "off") {
              throw new Error("Browser automation is disabled in settings.");
            }
            if (automationLevel === "safe" && event.input.command === "evaluate") {
              throw new Error("Browser automation safe mode blocks evaluate.");
            }
            if (event.input.command === "openUrl") {
              if (!event.input.url) throw new Error("Missing url.");
              openUrlInProjectRef.current(projectKey, event.input.url);
              await postCommandResult(event, { ok: true, data: { url: event.input.url } });
              return;
            }
            const data = await runBrowserAutomationCommandForProject(projectKey, event.input);
            await postCommandResult(event, { ok: true, data });
          } catch (error) {
            await postCommandResult(event, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      });
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [connectionsVersion]);

  useEffect(() => {
    if (!window.desktopBridge) return;
    return window.desktopBridge.onBrowserOpenUrlRequest((url) => openUrl(url));
  }, [openUrl]);

  return null;
}
