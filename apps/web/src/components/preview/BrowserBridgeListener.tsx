import { useEffect } from "react";
import type { BrowserBridgeCommandEvent } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { useSettings } from "../../hooks/useSettings";
import { runActiveBrowserAutomationCommand } from "./BrowserAutomationRegistry";
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
 * 1. WS-подписка на bridge-события текущего окружения чата — так модель из
 *    любого харнесса открывает страницу пользователю через серверный endpoint.
 * 2. Пуш от Electron main-процесса — target=_blank/window.open изнутри
 *    webview превращается в новую браузерную вкладку.
 */
export function BrowserBridgeListener() {
  const { openUrl, currentChatEnvironmentId } = usePreviewPane();
  const browserAutomationLevel = useSettings((settings) => settings.browserAutomationLevel);

  useEffect(() => {
    if (!currentChatEnvironmentId) return;
    const api = readEnvironmentApi(currentChatEnvironmentId);
    if (!api) return;
    return api.browser.subscribeBridge((event) => {
      if (event.type === "openUrl") {
        openUrl(event.url);
        return;
      }
      void (async () => {
        try {
          if (browserAutomationLevel === "off") {
            throw new Error("Browser automation is disabled in settings.");
          }
          if (browserAutomationLevel === "safe" && event.input.command === "evaluate") {
            throw new Error("Browser automation safe mode blocks evaluate.");
          }
          if (event.input.command === "openUrl") {
            if (!event.input.url) throw new Error("Missing url.");
            openUrl(event.input.url);
            await postCommandResult(event, { ok: true, data: { url: event.input.url } });
            return;
          }
          const data = await runActiveBrowserAutomationCommand(event.input);
          await postCommandResult(event, { ok: true, data });
        } catch (error) {
          await postCommandResult(event, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
  }, [browserAutomationLevel, currentChatEnvironmentId, openUrl]);

  useEffect(() => {
    if (!window.desktopBridge) return;
    return window.desktopBridge.onBrowserOpenUrlRequest((url) => openUrl(url));
  }, [openUrl]);

  return null;
}
