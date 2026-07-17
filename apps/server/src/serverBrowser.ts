import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeRequestContext,
} from "@t3tools/contracts";
import {
  buildClickSelectorScript,
  buildClickTextScript,
  buildTypeScript,
} from "@t3tools/shared/browserAutomationScripts";
import { Context, Data, Duration, Effect, Layer, Option, Ref } from "effect";
import * as Semaphore from "effect/Semaphore";
import type { BrowserContext, Page } from "playwright-core";

import {
  bridgeContextKey,
  commandTimeoutMs,
  normalizeBridgeRequestContext,
} from "./browserBridge.ts";
import { ServerConfig } from "./config.ts";

/**
 * Серверный исполнитель bridge-команд: headless Chromium (playwright-core).
 * Второй исполнитель рядом с Electron-webview клиента — используется, когда
 * ни один web-клиент не подписан на bridge (headless-сервер, Telegram) или
 * когда настройка `browser.executor` требует серверного исполнения.
 *
 * Браузер запускается лениво при первой команде; профиль персистентный
 * (`<stateDir>/browser-profile`), поэтому логины переживают рестарты.
 * Страница на каждый bridge-контекст (threadId/cwd) — тот же ключ, что у
 * scoped-токенов. Команды на одной странице сериализуются.
 */

export interface ServerBrowserShape {
  /** Никогда не фейлится: любая ошибка сворачивается в `result.error`. */
  readonly execute: (
    input: BrowserAutomationCommandInput,
    context?: BrowserBridgeRequestContext,
  ) => Effect.Effect<BrowserAutomationCommandResult>;
  readonly shutdown: Effect.Effect<void>;
}

export class ServerBrowser extends Context.Service<ServerBrowser, ServerBrowserShape>()(
  "t3/serverBrowser",
) {}

export const SERVER_BROWSER_EXECUTABLE_ENV = "UNO_WORK_BROWSER_EXECUTABLE";

const CHROMIUM_MISSING_ERROR =
  "Server-side browser unavailable: Chromium executable not found. " +
  'Run "npx playwright install chromium" on the server host, or set ' +
  `${SERVER_BROWSER_EXECUTABLE_ENV} to a Chromium/Chrome binary path.`;

function launchErrorMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/executable doesn't exist|executable not found/i.test(detail)) {
    return CHROMIUM_MISSING_ERROR;
  }
  return `Server-side browser failed to launch: ${detail}. If the server runs under Bun, try Node.`;
}

/** Ошибка исполнения — только сообщение: execute сворачивает её в result. */
class ServerBrowserCommandError extends Data.TaggedError("ServerBrowserCommandError")<{
  readonly message: string;
}> {}

function commandErrorMessage(cause: unknown): string {
  if (cause instanceof ServerBrowserCommandError) return cause.message;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Browser page error: ${detail}`;
}

/** Признак, что страница/браузер умерли и команду стоит повторить на свежей странице. */
function isClosedPageError(cause: unknown): boolean {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return /has been closed|browser closed|target closed|crashed/i.test(detail);
}

interface PageEntry {
  readonly page: Page;
  readonly semaphore: Semaphore.Semaphore;
}

async function runCommand(page: Page, input: BrowserAutomationCommandInput): Promise<unknown> {
  switch (input.command) {
    case "openUrl":
    case "navigate": {
      if (!input.url) throw new ServerBrowserCommandError({ message: "Missing url." });
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      return { url: input.url };
    }
    case "state":
      return {
        url: page.url(),
        title: await page.title(),
        // У playwright нет API истории навигации; best-effort через history.
        canGoBack: Boolean(await page.evaluate("window.history.length > 1")),
        canGoForward: false,
        loading: false,
      };
    case "screenshot": {
      const image = await page.screenshot({ type: "png", fullPage: input.fullPage === true });
      return { dataUrl: `data:image/png;base64,${image.toString("base64")}` };
    }
    case "click": {
      if (input.selector) {
        return page.evaluate(buildClickSelectorScript(input.selector));
      }
      if (input.x === undefined || input.y === undefined) {
        throw new ServerBrowserCommandError({
          message: "Click requires selector or x/y coordinates.",
        });
      }
      await page.mouse.click(input.x, input.y);
      return { clicked: true, x: input.x, y: input.y };
    }
    case "clickText":
      if (!input.text) throw new ServerBrowserCommandError({ message: "Missing text." });
      return page.evaluate(buildClickTextScript(input.text));
    case "type": {
      if (input.selector) {
        return page.evaluate(buildTypeScript(input.selector, input.value ?? input.text ?? ""));
      }
      await page.keyboard.insertText(input.value ?? input.text ?? "");
      return { typed: true };
    }
    case "press":
      if (!input.key)
        throw new ServerBrowserCommandError({ message: "press requires key support." });
      await page.keyboard.press(input.key);
      return { pressed: input.key };
    case "reload":
      await page.reload();
      return { reloaded: true };
    case "back": {
      await page.goBack();
      return { canGoBack: Boolean(await page.evaluate("window.history.length > 1")) };
    }
    case "forward": {
      const response = await page.goForward();
      return { canGoForward: response !== null };
    }
    case "evaluate":
      if (!input.script) throw new ServerBrowserCommandError({ message: "Missing script." });
      return page.evaluate(input.script);
  }
}

export const makeServerBrowser = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const profileDir = join(config.stateDir, "browser-profile");

  // Ленивый запуск под мьютексом. Не Effect.cached: он навсегда мемоизировал
  // бы неудачный запуск, а нужен ретрай на следующей команде.
  const launchSemaphore = yield* Semaphore.make(1);
  const contextRef = yield* Ref.make<BrowserContext | null>(null);
  // Страницы конечны, как и треды — рост карты ограничен (см. scoped-токены
  // в browserBridge.ts).
  const pagesByContextKey = new Map<string, PageEntry>();

  const launch = Effect.gen(function* () {
    if (process.versions.bun !== undefined) {
      yield* Effect.logWarning(
        "server browser executor running under Bun; playwright-core is not officially supported on Bun",
      );
    }
    const playwright = yield* Effect.tryPromise({
      try: () => import("playwright-core"),
      catch: (cause) => new ServerBrowserCommandError({ message: launchErrorMessage(cause) }),
    });
    const executablePath = process.env[SERVER_BROWSER_EXECUTABLE_ENV]?.trim() || undefined;
    return yield* Effect.tryPromise({
      try: () =>
        playwright.chromium.launchPersistentContext(profileDir, {
          headless: true,
          viewport: { width: 1280, height: 800 },
          ...(executablePath ? { executablePath } : {}),
        }),
      catch: (cause) => new ServerBrowserCommandError({ message: launchErrorMessage(cause) }),
    });
  });

  const getBrowserContext = launchSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const existing = yield* Ref.get(contextRef);
      if (existing && existing.browser()?.isConnected() !== false) {
        return existing;
      }
      pagesByContextKey.clear();
      const launched = yield* launch;
      yield* Ref.set(contextRef, launched);
      return launched;
    }),
  );

  const getPageEntry = (context: BrowserBridgeRequestContext | undefined) =>
    Effect.gen(function* () {
      const browserContext = yield* getBrowserContext;
      const key = bridgeContextKey(
        (context ? normalizeBridgeRequestContext(context) : undefined) ?? {},
      );
      const existing = pagesByContextKey.get(key);
      if (existing && !existing.page.isClosed()) {
        return existing;
      }
      const page = yield* Effect.tryPromise({
        try: () => browserContext.newPage(),
        catch: (cause) => new ServerBrowserCommandError({ message: commandErrorMessage(cause) }),
      });
      const semaphore = existing?.semaphore ?? (yield* Semaphore.make(1));
      const entry: PageEntry = { page, semaphore };
      pagesByContextKey.set(key, entry);
      return entry;
    });

  const dispatch = (
    input: BrowserAutomationCommandInput,
    context: BrowserBridgeRequestContext | undefined,
  ): Effect.Effect<unknown, ServerBrowserCommandError> =>
    Effect.gen(function* () {
      const entry = yield* getPageEntry(context);
      return yield* entry.semaphore.withPermits(1)(
        Effect.tryPromise({
          try: () => runCommand(entry.page, input),
          catch: (cause) => new ServerBrowserCommandError({ message: commandErrorMessage(cause) }),
        }),
      );
    });

  const execute: ServerBrowserShape["execute"] = (input, context) =>
    Effect.gen(function* () {
      const commandId = `server-${randomBytes(12).toString("hex")}`;
      const timeoutMs = commandTimeoutMs(input);
      const attempt = dispatch(input, context).pipe(
        // Умершая страница/браузер: одно пересоздание (getPageEntry заметит
        // isClosed/disconnected) и повтор.
        Effect.catch((error) =>
          isClosedPageError(error) ? dispatch(input, context) : Effect.fail(error),
        ),
      );
      const outcome: BrowserAutomationCommandResult = yield* attempt.pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.map(
          Option.match({
            onSome: (data) => ({ ok: true, commandId, data }),
            onNone: () => ({
              ok: false,
              commandId,
              error: `Browser command timed out after ${timeoutMs}ms.`,
            }),
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed({ ok: false, commandId, error: commandErrorMessage(error) }),
        ),
      );
      return outcome;
    });

  const shutdown = Effect.gen(function* () {
    const existing = yield* Ref.get(contextRef);
    if (!existing) return;
    yield* Ref.set(contextRef, null);
    pagesByContextKey.clear();
    yield* Effect.promise(() => existing.close().catch(() => undefined));
  });

  yield* Effect.addFinalizer(() => shutdown.pipe(Effect.timeout("5 seconds"), Effect.ignore));

  return { execute, shutdown } satisfies ServerBrowserShape;
});

export const ServerBrowserLive = Layer.effect(ServerBrowser, makeServerBrowser);

/** Стаб для тестов: серверного браузера нет, любая команда — ошибка. */
export const ServerBrowserTest = Layer.succeed(ServerBrowser, {
  execute: () =>
    Effect.succeed({
      ok: false,
      commandId: "test",
      error: "Server-side browser is unavailable in tests.",
    }),
  shutdown: Effect.void,
});
