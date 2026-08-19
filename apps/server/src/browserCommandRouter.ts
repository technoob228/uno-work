import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeRequestContext,
  BrowserExecutor,
  ServerBrowserSettings,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  emptyFrameMessage,
  isEmptyFrameError,
  isEmptyScreenshotResultData,
} from "@t3tools/shared/browserScreenshot";
import { Effect } from "effect";

import { BrowserBridge, type BrowserBridgeShape } from "./browserBridge.ts";
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

/** Короткий зонд `state` перед headless-фолбэком: панель жива, ответ мгновенный. */
const STATE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Панель снимает только видимую область и игнорирует `fullPage`, поэтому
 * полностраничный снимок всегда уходит в headless — иначе флаг молча ничего
 * не делал бы.
 */
export function requiresServerExecutor(input: BrowserAutomationCommandInput): boolean {
  return input.command === "screenshot" && input.fullPage === true;
}

/**
 * Пустой кадр от клиента: либо честная ошибка `empty_frame` от свежей панели,
 * либо `ok: true` с нулевым PNG от клиента старой версии.
 */
export function isEmptyFrameOutcome(result: BrowserAutomationCommandResult): boolean {
  return result.ok ? isEmptyScreenshotResultData(result.data) : isEmptyFrameError(result.error);
}

/** URL страницы из результата команды `state` — цель для headless-фолбэка. */
function readStateUrl(result: BrowserAutomationCommandResult): string | undefined {
  if (!result.ok || typeof result.data !== "object" || result.data === null) return undefined;
  const url = (result.data as { url?: unknown }).url;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

function withFallbackMarker(
  result: BrowserAutomationCommandResult,
): BrowserAutomationCommandResult {
  if (!result.ok || typeof result.data !== "object" || result.data === null) return result;
  return { ...result, data: { ...(result.data as object), fallbackFrom: "panel" } };
}

/**
 * Гарантия «пустой кадр — это не успех»: `ok: true` с нулевым PNG от старого
 * клиента превращается в ошибку `empty_frame`.
 */
function normalizeEmptyFrameResult(
  result: BrowserAutomationCommandResult,
): BrowserAutomationCommandResult {
  if (!result.ok) return result;
  return {
    ok: false,
    commandId: result.commandId,
    error: emptyFrameMessage({ capturedBy: "panel", attempts: 1, bytes: 0 }),
  };
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
    const serverAvailable = browserSettings.serverAutomationLevel !== "off";
    const hasSubscribers = yield* browserBridge.hasSubscribers;
    const target =
      requiresServerExecutor(input) && serverAvailable
        ? "server"
        : decideBrowserExecutorTarget({
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
      const result = yield* browserBridge.publishCommand(input, context);
      if (input.command !== "screenshot" || !isEmptyFrameOutcome(result)) {
        return result;
      }
      // Панель отдала пустой кадр (вкладка не композитится). Досняли бы её
      // повторно — панель уже пробовала; остаётся headless.
      if (!serverAvailable) return normalizeEmptyFrameResult(result);
      const fallback = yield* captureOnServerBrowser(input, context, browserBridge);
      return fallback.ok ? withFallbackMarker(fallback) : normalizeEmptyFrameResult(result);
    }

    if (!serverAvailable) {
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
 * Headless-дубль снимка для фолбэка: серверная страница живёт своей жизнью,
 * поэтому её сначала уводят на URL, открытый сейчас в панели, — иначе кадр
 * был бы снят с чужой страницы и молча выдан за снимок панели.
 */
const captureOnServerBrowser = (
  input: BrowserAutomationCommandInput,
  context: BrowserBridgeRequestContext | undefined,
  browserBridge: BrowserBridgeShape,
): Effect.Effect<BrowserAutomationCommandResult, never, ServerBrowser> =>
  Effect.gen(function* () {
    const serverBrowser = yield* ServerBrowser;
    const panelState = yield* browserBridge.publishCommand(
      { command: "state", timeoutMs: STATE_PROBE_TIMEOUT_MS },
      context,
    );
    const url = readStateUrl(panelState);
    if (url) {
      yield* serverBrowser.execute({ command: "openUrl", url }, context);
    }
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
