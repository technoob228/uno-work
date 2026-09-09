import { useEffect, useRef, useState } from "react";
import type { BrowserBridgeCommandEvent } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../store";
import {
  findBrowserTabAutomationHandler,
  runBrowserAutomationCommand,
} from "./BrowserAutomationRegistry";
import { resolveBridgeEventProjectKey } from "./browserBridgeRouting";
import { detectFileKind, usePreviewPane } from "./PreviewPaneContext";
import { automationScopeKeys, type PreviewTabScope } from "./previewTabScopes";
import { addSecretRequest, removeSecretRequest } from "../../secretRequestStore";
import {
  detectBrowserExtension,
  isBrowserExtensionConnected,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { isWebApp } from "../../webMode";

const EXTENSION_MISSING_MESSAGE =
  "No browser to drive: install the Uno Work Companion extension to act in this browser, or set the browser executor to the machine's own browser in settings.";

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
  const { openUrl, openUrlForTarget, openFileForTarget, currentProjectKey, currentChatThreadId } =
    usePreviewPane();
  const browserAutomationLevel = useSettings((settings) => settings.browserAutomationLevel);
  const groupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));

  // Меняющиеся значения — через ref, чтобы не пересоздавать WS-подписки при
  // каждом переключении проекта или правке настроек.
  const currentProjectKeyRef = useRef(currentProjectKey);
  currentProjectKeyRef.current = currentProjectKey;
  const currentThreadIdRef = useRef(currentChatThreadId);
  currentThreadIdRef.current = currentChatThreadId;
  const groupingSettingsRef = useRef(groupingSettings);
  groupingSettingsRef.current = groupingSettings;
  const automationLevelRef = useRef(browserAutomationLevel);
  automationLevelRef.current = browserAutomationLevel;
  const openUrlForTargetRef = useRef(openUrlForTarget);
  openUrlForTargetRef.current = openUrlForTarget;
  const openFileForTargetRef = useRef(openFileForTarget);
  openFileForTargetRef.current = openFileForTarget;

  // Ask the companion extension to announce itself early, so the first bridge
  // command does not pay for the handshake.
  useEffect(() => {
    if (!isWebApp) return;
    void detectBrowserExtension();
  }, []);

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
        // Секретные события не привязаны к вкладке предпросмотра — им не нужен
        // projectKey, а у secretSettled и вовсе нет контекста.
        if (event.type === "secretRequest") {
          addSecretRequest({ event, environmentId: connection.environmentId });
          return;
        }
        if (event.type === "secretSettled") {
          removeSecretRequest(event.requestId);
          return;
        }
        const projectKey =
          resolveBridgeEventProjectKey({
            context: event.context,
            environmentId: connection.environmentId,
            state: useStore.getState(),
            groupingSettings: groupingSettingsRef.current,
          }) ?? currentProjectKeyRef.current;
        // Вкладка принадлежит треду-источнику, а не тому чату, что на экране:
        // так вкладки, открытые агентом в одном чате, не засоряют другие.
        // Тред неизвестен (легаси-токен) — деградируем до текущего.
        const target = {
          projectKey,
          threadId: event.context?.threadId ?? currentThreadIdRef.current,
        };
        const scope: PreviewTabScope =
          event.type === "openUrl" || event.type === "openFile" ? (event.scope ?? "chat") : "chat";

        if (event.type === "openUrl") {
          if (isWebApp) {
            void runExtensionBrowserCommand({ command: "openUrl", url: event.url }).catch(
              () => undefined,
            );
            return;
          }
          openUrlForTargetRef.current(target, scope, event.url);
          return;
        }
        if (event.type === "openFile") {
          // Файлы рендерятся в самой панели (не в webview), поэтому путь один
          // для Electron и браузерного режима: контент подтянется лениво через
          // filesystem.readFile окружения-источника.
          const name = event.path.split(/[\\/]/).findLast(Boolean) ?? event.path;
          openFileForTargetRef.current(target, scope, {
            id: event.path,
            name,
            kind: detectFileKind(name),
            content: "",
            path: event.path,
            environmentId: connection.environmentId,
            projectKey,
          });
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
            // Автозаполнение логина адресовано конкретной вкладке (её id знает
            // только клиент, открывший вкладку). Если такой вкладки здесь нет —
            // команда не для нас: в вебе её исполнит companion в своей вкладке.
            if (event.input.command === "fillCredential" && event.input.tabId && !isWebApp) {
              const handler = findBrowserTabAutomationHandler(event.input.tabId);
              if (!handler) {
                throw new Error("Вкладка для автозаполнения больше не открыта.");
              }
              const data = await handler(event.input);
              await postCommandResult(event, { ok: true, data });
              return;
            }
            // The hosted build has no Electron webview: commands run in the
            // user's own tabs through the companion extension.
            if (isWebApp) {
              if (!isBrowserExtensionConnected() && (await detectBrowserExtension()) === null) {
                throw new Error(EXTENSION_MISSING_MESSAGE);
              }
              const data = await runExtensionBrowserCommand(event.input);
              await postCommandResult(event, { ok: true, data });
              return;
            }
            if (event.input.command === "openUrl") {
              if (!event.input.url) throw new Error("Missing url.");
              openUrlForTargetRef.current(target, scope, event.input.url);
              await postCommandResult(event, { ok: true, data: { url: event.input.url } });
              return;
            }
            const data = await runBrowserAutomationCommand(
              automationScopeKeys(target),
              event.input,
            );
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
