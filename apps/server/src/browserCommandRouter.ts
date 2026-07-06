import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeRequestContext,
  BrowserExecutor,
  ServerBrowserSettings,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Effect } from "effect";

import { BrowserBridge } from "./browserBridge.ts";
import { ServerBrowser } from "./serverBrowser.ts";
import { ServerSettingsService } from "./serverSettings.ts";

/**
 * Роутинг bridge-команд между двумя исполнителями: подключённым web-клиентом
 * (Electron webview, через PubSub + /api/browser/command/result) и серверным
 * headless Chromium ({@link ServerBrowser}). `auto` предпочитает клиента и
 * падает на сервер, когда никто не подписан — headless/Telegram-сценарий.
 */
export function decideBrowserExecutorTarget(input: {
  readonly executor: BrowserExecutor;
  readonly hasSubscribers: boolean;
}): "client" | "server" {
  if (input.executor === "server") return "server";
  if (input.executor === "local") return "client";
  return input.hasSubscribers ? "client" : "server";
}

function blockedResult(error: string): BrowserAutomationCommandResult {
  return { ok: false, commandId: "blocked", error };
}

const readBrowserSettings: Effect.Effect<ServerBrowserSettings, never, ServerSettingsService> =
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    return (yield* settingsService.getSettings).browser;
  }).pipe(
    // Фейл настроек не должен ломать bridge — деградируем к дефолтам.
    Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS.browser)),
  );

/**
 * Исполнить bridge-команду выбранным исполнителем. Никогда не фейлится:
 * блокировки политики и ошибки исполнителя сворачиваются в `result.error`.
 */
export const executeBridgeCommand = (
  input: BrowserAutomationCommandInput,
  context: BrowserBridgeRequestContext | undefined,
): Effect.Effect<
  BrowserAutomationCommandResult,
  never,
  BrowserBridge | ServerBrowser | ServerSettingsService
> =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const browserSettings = yield* readBrowserSettings;
    const hasSubscribers = yield* browserBridge.hasSubscribers;
    const target = decideBrowserExecutorTarget({
      executor: browserSettings.executor,
      hasSubscribers,
    });

    if (target === "client") {
      if (!hasSubscribers) {
        // Достижимо только при executor="local": быстрый fail вместо
        // 30-секундного таймаута публикации в пустой PubSub.
        return blockedResult(
          "No connected app client is available to execute browser commands (browserExecutor=local).",
        );
      }
      return yield* browserBridge.publishCommand(input, context);
    }

    if (browserSettings.serverAutomationLevel === "off") {
      return blockedResult(
        "Server-side browser automation is disabled in settings (browser.serverAutomationLevel=off).",
      );
    }
    if (browserSettings.serverAutomationLevel === "safe" && input.command === "evaluate") {
      return blockedResult("Browser automation safe mode blocks evaluate.");
    }
    const serverBrowser = yield* ServerBrowser;
    return yield* serverBrowser.execute(input, context);
  });

/**
 * Открыть URL выбранным исполнителем. Клиентский путь — fire-and-forget
 * публикация (как раньше); серверный — реальная загрузка страницы в headless
 * Chromium, чтобы последующие команды видели её.
 */
export const executeBridgeOpenUrl = (
  url: string,
  context: BrowserBridgeRequestContext | undefined,
): Effect.Effect<
  BrowserAutomationCommandResult,
  never,
  BrowserBridge | ServerBrowser | ServerSettingsService
> =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const browserSettings = yield* readBrowserSettings;
    const hasSubscribers = yield* browserBridge.hasSubscribers;
    const target = decideBrowserExecutorTarget({
      executor: browserSettings.executor,
      hasSubscribers,
    });

    if (target === "client") {
      yield* browserBridge.publishOpenUrl(url, context);
      return { ok: true, commandId: "open" };
    }
    if (browserSettings.serverAutomationLevel === "off") {
      return blockedResult(
        "Server-side browser automation is disabled in settings (browser.serverAutomationLevel=off).",
      );
    }
    const serverBrowser = yield* ServerBrowser;
    return yield* serverBrowser.execute({ command: "openUrl", url }, context);
  });
