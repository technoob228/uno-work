import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { BrowserBridgeCommandEvent, EnvironmentId } from "@t3tools/contracts";

import { ConnectChannelDialog } from "../assistant/ConnectChannelDialog";

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
import { detectFileKind, makeAppFile, usePreviewPane } from "./PreviewPaneContext";
import { openInNewTab } from "../../navigation/useOpenApp";
import { automationScopeKeys, type PreviewTabScope } from "./previewTabScopes";
import { addSecretRequest, removeSecretRequest } from "../../secretRequestStore";
import { addToolApproval, removeToolApproval } from "../../toolApprovalStore";
import { dirname } from "../files/fileTypes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  detectBrowserExtension,
  isBrowserExtensionConnected,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { isWebApp } from "../../webMode";
import {
  AGENT_PRIVATE_URL_MESSAGE,
  isPrivateNetworkUrl,
  normalizeAgentBrowserUrl,
} from "./browserUrl";

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
/**
 * An agent asked to open an address on this computer or its local network:
 * nothing opens until the person clicks "Open".
 */
function askBeforeOpeningPrivateUrl(url: string, open: () => void): void {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw url
  }
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: `An agent wants to open ${host}`,
      description: "This address is on your computer or local network.",
      actionProps: { children: "Open", onClick: open },
    }),
  );
}

export function BrowserBridgeListener() {
  const {
    openUrl,
    openUrlForTarget,
    openFileForTarget,
    openAppTab,
    currentProjectKey,
    currentChatThreadId,
  } = usePreviewPane();
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
  const openAppTabRef = useRef(openAppTab);
  openAppTabRef.current = openAppTab;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // assistant_connect: the built-in assistant's Connect Telegram window,
  // shown over whatever is on screen (QR + Open Telegram → Start).
  const [connectTelegramIn, setConnectTelegramIn] = useState<EnvironmentId | null>(null);

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
        if (event.type === "toolApprovalRequest") {
          addToolApproval({ event, environmentId: connection.environmentId });
          return;
        }
        if (event.type === "toolApprovalSettled") {
          removeToolApproval(event.requestId);
          return;
        }
        if (event.type === "openInApp" && event.view === "app") {
          // An app's public address (open_in_panel): framed as the app in the
          // panel. An http address can't be framed inside https Uno Work, so
          // it is offered in a new tab (a click: popup blockers).
          const url = event.path;
          const name = event.name ?? url;
          const frameable = !(window.location.protocol === "https:" && /^http:/i.test(url));
          const here =
            !event.context?.threadId || event.context.threadId === currentThreadIdRef.current;
          if (frameable && here) {
            openAppTabRef.current(makeAppFile({ url, name }));
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: `${name} is ready to open`,
              description: url,
              actionProps: {
                children: "Open",
                onClick: () =>
                  frameable ? openAppTabRef.current(makeAppFile({ url, name })) : openInNewTab(url),
              },
            }),
          );
          return;
        }
        if (event.type === "openInApp" && event.view === "connect-telegram") {
          const open = () => setConnectTelegramIn(connection.environmentId);
          if (!event.context?.threadId || event.context.threadId === currentThreadIdRef.current) {
            open();
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Connect your assistant to Telegram",
              description: "Press Start in Telegram and Uno answers you there.",
              actionProps: { children: "Open", onClick: open },
            }),
          );
          return;
        }
        if (event.type === "openInApp") {
          const store = useStore.getState();
          const go = () => {
            if (store.activeEnvironmentId !== connection.environmentId) {
              store.setActiveEnvironmentId(connection.environmentId);
            }
            if (event.view === "office") {
              void navigateRef.current({ to: "/office", search: { path: event.path } });
            } else {
              void navigateRef.current({
                to: "/files",
                search: { path: dirname(event.path), file: event.path },
              });
            }
          };
          // Switch views only for the chat the person is looking at; an
          // agent in a background chat offers it instead of yanking the screen.
          if (!event.context?.threadId || event.context.threadId === currentThreadIdRef.current) {
            go();
            return;
          }
          const name = event.path.split("/").pop() ?? event.path;
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: `An agent wants to show you ${name}`,
              actionProps: { children: "Open", onClick: go },
            }),
          );
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
        // так вкладки, открытые агентом в одном чате, не засоряют другие, а
        // панель, которую человек в этом чате закрыл, агент не распахивает
        // (вкладка добавится, на кнопке панели загорится бейдж).
        // Тред неизвестен (легаси-токен) — деградируем до текущего.
        const target = {
          projectKey,
          threadId: event.context?.threadId ?? currentThreadIdRef.current,
        };
        const scope: PreviewTabScope =
          event.type === "openUrl" || event.type === "openFile" ? (event.scope ?? "chat") : "chat";

        if (event.type === "openUrl") {
          const url = normalizeAgentBrowserUrl(event.url);
          if (!url) return;
          if (isPrivateNetworkUrl(url)) {
            askBeforeOpeningPrivateUrl(url, () => {
              if (isWebApp) {
                void runExtensionBrowserCommand({ command: "openUrl", url }).catch(() => undefined);
              } else {
                openUrlForTargetRef.current(target, scope, url, "person");
              }
            });
            return;
          }
          if (isWebApp) {
            void runExtensionBrowserCommand({ command: "openUrl", url }).catch(() => undefined);
            return;
          }
          openUrlForTargetRef.current(target, scope, url, "agent");
          return;
        }
        if (event.type === "openFile") {
          // Файлы рендерятся в самой панели (не в webview), поэтому путь один
          // для Electron и браузерного режима: контент подтянется лениво через
          // filesystem.readFile окружения-источника.
          const name = event.path.split(/[\\/]/).findLast(Boolean) ?? event.path;
          openFileForTargetRef.current(
            target,
            scope,
            {
              id: event.path,
              name,
              kind: detectFileKind(name),
              content: "",
              path: event.path,
              environmentId: connection.environmentId,
              projectKey,
            },
            "agent",
          );
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
                throw new Error("The tab to fill in is no longer open.");
              }
              const data = await handler(event.input);
              await postCommandResult(event, { ok: true, data });
              return;
            }
            // The hosted build has no Electron webview: commands run in the
            // user's own tabs through the companion extension.
            // Agents may not steer the browser at this computer or its LAN
            // (the local daemon, router pages, other machines) on their own.
            const agentUrl =
              event.input.command === "openUrl" || event.input.command === "navigate"
                ? normalizeAgentBrowserUrl(event.input.url)
                : null;
            if (
              (event.input.command === "openUrl" || event.input.command === "navigate") &&
              !agentUrl
            ) {
              throw new Error("Only http(s) addresses can be opened.");
            }
            if (agentUrl && isPrivateNetworkUrl(agentUrl)) {
              askBeforeOpeningPrivateUrl(agentUrl, () =>
                isWebApp
                  ? void runExtensionBrowserCommand({ command: "openUrl", url: agentUrl }).catch(
                      () => undefined,
                    )
                  : openUrlForTargetRef.current(target, scope, agentUrl, "person"),
              );
              throw new Error(AGENT_PRIVATE_URL_MESSAGE);
            }
            if (isWebApp) {
              if (!isBrowserExtensionConnected() && (await detectBrowserExtension()) === null) {
                throw new Error(EXTENSION_MISSING_MESSAGE);
              }
              const data = await runExtensionBrowserCommand(event.input);
              await postCommandResult(event, { ok: true, data });
              return;
            }
            if (event.input.command === "openUrl" && agentUrl) {
              openUrlForTargetRef.current(target, scope, agentUrl, "agent");
              await postCommandResult(event, { ok: true, data: { url: agentUrl } });
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

  return connectTelegramIn ? (
    <ConnectChannelDialog
      environmentId={connectTelegramIn}
      channel="telegram"
      onClose={() => setConnectTelegramIn(null)}
    />
  ) : null;
}
