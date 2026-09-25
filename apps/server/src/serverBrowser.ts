import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeRequestContext,
  BrowserLiveControl,
  BrowserLiveFrame,
  BrowserLiveHelpRequest,
  BrowserLiveInputEvent,
  BrowserLiveLocation,
  BrowserLiveNavigateInput,
  BrowserLivePage,
  BrowserLiveSetProxyInput,
  BrowserLiveSetup,
  BrowserLiveState,
} from "@t3tools/contracts";
import { BROWSER_LIVE_SETUP_PAGE_ID, BrowserLiveError } from "@t3tools/contracts";
import {
  buildClickSelectorScript,
  buildClickTextScript,
  buildFillLoginScript,
  buildTypeScript,
} from "@t3tools/shared/browserAutomationScripts";
import {
  emptyFrameMessage,
  isEmptyScreenshot,
  pngDataUrl,
  screenshotBytes,
  type ScreenshotResultData,
} from "@t3tools/shared/browserScreenshot";
import { Context, Data, Duration, Effect, Layer, Option, Queue, Ref, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import {
  bridgeContextKey,
  commandTimeoutMs,
  normalizeBridgeRequestContext,
} from "./browserBridge.ts";
import {
  browserSetupPathsFromEnv,
  isChromiumInstalled,
  makeBrowserSetupController,
  READY_SETUP,
  setupMessageForAgent,
  type BrowserSetupController,
} from "./browserSetup.ts";
import { ServerConfig } from "./config.ts";

/**
 * Серверный исполнитель bridge-команд: Chromium самой машины (playwright-core).
 * Второй исполнитель рядом с Electron-webview клиента — используется, когда
 * демон работает на сервере (Work в облаке: браузер живёт там же, где агент),
 * когда ни один клиент не подписан на bridge (Telegram) или когда настройка
 * `browser.executor` требует серверного исполнения.
 *
 * Браузер запускается лениво при первой команде; профиль персистентный
 * (`<stateDir>/browser-profile`), поэтому логины переживают рестарты. На
 * Linux с Xvfb это настоящее окно на виртуальном экране (headful): сайты
 * режут headless заметно чаще. Страница на каждый bridge-контекст
 * (threadId/cwd) — тот же ключ, что у scoped-токенов. Команды на одной
 * странице сериализуются.
 *
 * Live view (`live`): приложение видит страницы кадрами CDP screencast и
 * может взять управление. Пока управление у человека, команды агента,
 * меняющие страницу, ждут; `requestHelp` зовёт человека и ждёт, пока браузер
 * вернут.
 */

export interface ServerBrowserLiveShape {
  readonly state: Effect.Effect<BrowserLiveState>;
  /** Текущее состояние, затем каждое изменение. */
  readonly changes: Stream.Stream<BrowserLiveState>;
  readonly frames: (pageId: string) => Stream.Stream<BrowserLiveFrame, BrowserLiveError>;
  readonly input: (
    pageId: string,
    event: BrowserLiveInputEvent,
  ) => Effect.Effect<void, BrowserLiveError>;
  readonly setControl: (
    pageId: string,
    control: BrowserLiveControl,
  ) => Effect.Effect<BrowserLiveState, BrowserLiveError>;
  readonly navigate: (input: BrowserLiveNavigateInput) => Effect.Effect<void, BrowserLiveError>;
  readonly open: (
    context: BrowserBridgeRequestContext,
    url: string,
  ) => Effect.Effect<{ readonly pageId: string }, BrowserLiveError>;
  readonly close: (pageId: string) => Effect.Effect<void, BrowserLiveError>;
  readonly resize: (
    pageId: string,
    width: number,
    height: number,
  ) => Effect.Effect<void, BrowserLiveError>;
  readonly copySelection: (pageId: string) => Effect.Effect<string, BrowserLiveError>;
  readonly setProxy: (
    input: BrowserLiveSetProxyInput,
  ) => Effect.Effect<BrowserLiveState, BrowserLiveError>;
  /** Поставить браузер машины сейчас (кнопка «Try again»). */
  readonly setup: Effect.Effect<BrowserLiveState, BrowserLiveError>;
}

export interface ServerBrowserShape {
  /** Никогда не фейлится: любая ошибка сворачивается в `result.error`. */
  readonly execute: (
    input: BrowserAutomationCommandInput,
    context?: BrowserBridgeRequestContext,
  ) => Effect.Effect<BrowserAutomationCommandResult>;
  readonly live: ServerBrowserLiveShape;
  readonly shutdown: Effect.Effect<void>;
}

export class ServerBrowser extends Context.Service<ServerBrowser, ServerBrowserShape>()(
  "t3/serverBrowser",
) {}

export const SERVER_BROWSER_EXECUTABLE_ENV = "UNO_WORK_BROWSER_EXECUTABLE";
/** `1` — всегда headless, даже когда есть Xvfb (тесты, слабые машины). */
export const SERVER_BROWSER_HEADLESS_ENV = "UNO_WORK_BROWSER_HEADLESS";

const VIEWPORT = { width: 1280, height: 800 } as const;
const MIN_VIEWPORT = { width: 360, height: 400 } as const;
const MAX_VIEWPORT = { width: 1920, height: 1200 } as const;

/** Выделенный на странице текст: в поле ввода — его выделение, иначе — документа. */
const SELECTION_SCRIPT = `(() => {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && typeof el.selectionStart === "number") {
    if (el.type === "password") return "";
    return el.value.slice(el.selectionStart, el.selectionEnd ?? el.selectionStart);
  }
  return String(window.getSelection() ?? "");
})()`;

const CHROMIUM_MISSING_ERROR =
  "Server-side browser unavailable: Chromium executable not found. " +
  'Run "npx playwright install chromium" on the server host, or set ' +
  `${SERVER_BROWSER_EXECUTABLE_ENV} to a Chromium/Chrome binary path.`;

/**
 * Сколько команда агента ждёт установку браузера при первом использовании
 * (типично ~30–45 с на 1 vCPU), прежде чем ответить «повтори позже».
 */
export const SERVER_BROWSER_SETUP_WAIT_MS = 45_000;
/**
 * Только что поставленный браузер может не подняться с первого раза (CDP,
 * первая вкладка): пробуем ещё столько, прежде чем отдать ошибку.
 */
export const SERVER_BROWSER_READY_RETRY_MS = 20_000;
const SERVER_BROWSER_READY_RETRY_STEP_MS = 1_000;

/** Команды, которые не меняют страницу: агенту можно смотреть, пока рулит человек. */
const OBSERVE_COMMANDS = new Set<BrowserAutomationCommandInput["command"]>([
  "state",
  "screenshot",
  // Подставляет сервер по нажатию человека (vault.fill), не агент.
  "fillCredential",
]);

const HUMAN_IN_CONTROL_ERROR =
  "The person has taken control of this browser and is using it right now. " +
  "Do not retry in a loop: tell them in chat what you are waiting for, or call " +
  '{"command":"requestHelp","text":"<what you need>"} — it returns when they hand the browser back.';

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
  readonly pageId: string;
  readonly key: string;
  readonly page: Page;
  readonly semaphore: Semaphore.Semaphore;
  /**
   * Ввод человека по порядку: клиент шлёт события не дожидаясь ответа
   * (иначе печать упиралась бы в круг до машины на каждую клавишу).
   */
  readonly inputSemaphore: Semaphore.Semaphore;
  readonly context: BrowserBridgeRequestContext | undefined;
  /** Размер страницы: агентский VIEWPORT или размер панели, пока рулит человек. */
  viewport: { width: number; height: number };
  title: string;
  control: BrowserLiveControl;
  help: BrowserLiveHelpRequest | null;
  attention: number;
  /** Команды агента, ждущие возврата управления. */
  agentWaiting: number;
  /** Ждут `control → agent` (возврат браузера человеком). */
  readonly controlWaiters: Set<() => void>;
  readonly frameListeners: Set<(frame: BrowserLiveFrame) => void>;
  lastFrame: BrowserLiveFrame | null;
  cdp: CDPSession | null;
  screencasting: boolean;
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
      const fullPage = input.fullPage === true;
      const image = await page.screenshot({ type: "png", fullPage });
      const dataUrl = pngDataUrl(image.toString("base64"));
      if (isEmptyScreenshot(dataUrl)) {
        throw new ServerBrowserCommandError({
          message: emptyFrameMessage({
            capturedBy: "headless",
            attempts: 1,
            bytes: screenshotBytes(dataUrl),
          }),
        });
      }
      const size = fullPage
        ? ((await page.evaluate(
            "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
          )) as { width: number; height: number } | null)
        : page.viewportSize();
      return {
        dataUrl,
        bytes: screenshotBytes(dataUrl),
        ...(size ? { width: size.width, height: size.height } : {}),
        fullPage,
        capturedBy: "headless",
        url: page.url(),
      } satisfies ScreenshotResultData;
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
    case "fillCredential": {
      // Значения приходят от сервера (vault.fill), не от агента — см.
      // credentialsFill.ts. В логи и в результат пароль не попадает.
      if (input.username === undefined || input.password === undefined) {
        throw new ServerBrowserCommandError({ message: "fillCredential requires credentials." });
      }
      const filled = await page.evaluate(buildFillLoginScript(input.username, input.password));
      if (filled !== true) {
        throw new ServerBrowserCommandError({
          message: "Поля логина на странице не найдены.",
        });
      }
      return { filled: true };
    }
    case "requestHelp":
      // Обрабатывается в execute: ждёт человека, а не страницу.
      throw new ServerBrowserCommandError({ message: "requestHelp is handled by execute." });
  }
}

/** Путь к бинарю в PATH или null. */
function findOnPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Виртуальный экран для headful-браузера. Xvfb сам выбирает свободный номер
 * дисплея (`-displayfd`) — демон работает с PrivateTmp, чужие X-локи ему не
 * видны. null — Xvfb нет или он не поднялся: браузер пойдёт headless.
 */
async function startVirtualDisplay(): Promise<{ display: string; process: ChildProcess } | null> {
  const xvfb = findOnPath("Xvfb");
  if (!xvfb) return null;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      xvfb,
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        `${VIEWPORT.width}x${VIEWPORT.height}x24`,
        "-nolisten",
        "tcp",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const finish = (value: { display: string; process: ChildProcess } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5_000);
    let buffered = "";
    const fd = child.stdio[3];
    fd?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = /(\d+)\s/.exec(buffered);
      if (match) finish({ display: `:${match[1]}`, process: child });
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
  });
}

// По имени, не по IP: запрос браузера через прокси к голому IP падает на
// проверке сертификата в playwright (SNI уходит как localhost).
const TRACE_URL = "https://one.one.one.one/cdn-cgi/trace";

/** Адрес и страна выхода из ответа Cloudflare trace (`ip=…`, `loc=…`). */
export function parseTrace(body: string): { ip: string | null; country: string | null } {
  const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim() || null;
  const loc = /^loc=([A-Z]{2})$/m.exec(body)?.[1] ?? null;
  return { ip, country: loc && loc !== "XX" ? loc : null };
}

/**
 * Адрес, который видят сайты. Спрашиваем Cloudflare trace: без ключа, без
 * третьих сервисов. С прокси — через сам браузер (его сеть идёт через прокси),
 * без прокси — из демона. null — не узнали (нет сети/таймаут).
 */
async function lookupExit(
  browserContext: BrowserContext | null,
): Promise<{ ip: string | null; country: string | null }> {
  try {
    if (browserContext) {
      const response = await browserContext.request.get(TRACE_URL, { timeout: 8_000 });
      return response.ok() ? parseTrace(await response.text()) : { ip: null, country: null };
    }
    const response = await fetch(TRACE_URL, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? parseTrace(await response.text()) : { ip: null, country: null };
  } catch {
    return { ip: null, country: null };
  }
}

interface BrowserProxyConfig {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

const PROXY_SERVER_RE = /^(https?|socks5):\/\/[^\s/:]+(:\d{1,5})?\/?$/i;

/** Проверка адреса прокси; текст ошибки — для человека. null — всё в порядке. */
export function proxyConfigProblem(config: BrowserProxyConfig): string | null {
  if (!PROXY_SERVER_RE.test(config.server)) {
    return "Proxy address should look like http://host:port or socks5://host:port.";
  }
  if (/^socks5:/i.test(config.server) && (config.username || config.password)) {
    return "Chrome can't use a SOCKS5 proxy with a password. Use the proxy's HTTP address.";
  }
  return null;
}

const PUBLIC_IP_TTL_MS = 10 * 60_000;

function stopScreencast(entry: PageEntry) {
  if (!entry.screencasting || !entry.cdp) return;
  entry.screencasting = false;
  void entry.cdp.send("Page.stopScreencast").catch(() => undefined);
}

/**
 * Одна страница на чат: агент может звать мост из worktree или подпапки (другой
 * cwd), а человек открывает страницу чата из панели — всё это одна вкладка.
 * Без треда (легаси-токены) — прежний ключ по cwd.
 */
function pageKeyFor(context: BrowserBridgeRequestContext | undefined): string {
  if (context?.threadId) return `thread:${context.threadId}`;
  return bridgeContextKey(context ?? {});
}

/** Клавиши, которых playwright не знает (IME, мёртвые) — молча пропускаем. */
const IGNORED_KEYS = new Set(["Unidentified", "Dead", "Process", "Compose"]);

export const makeServerBrowser = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const profileDir = join(config.stateDir, "browser-profile");
  const machine = hostname();

  // Ленивый запуск под мьютексом. Не Effect.cached: он навсегда мемоизировал
  // бы неудачный запуск, а нужен ретрай на следующей команде.
  const launchSemaphore = yield* Semaphore.make(1);
  const contextRef = yield* Ref.make<BrowserContext | null>(null);
  // Страницы конечны, как и треды — рост карты ограничен (см. scoped-токены
  // в browserBridge.ts).
  const pagesByContextKey = new Map<string, PageEntry>();
  const pagesById = new Map<string, PageEntry>();
  let display: { display: string; process: ChildProcess } | null = null;
  let displayMode: BrowserLiveLocation["display"] = "headless";
  let exit: { ip: string | null; country: string | null; at: number } | null = null;
  // Прокси браузера: адрес и логин в состоянии, пароль — только в файле 0600
  // рядом с остальными секретами демона (prepare-image.sh стирает userdata).
  const proxyPath = join(config.stateDir, "secrets", "browser-proxy.json");
  const readProxy = async (): Promise<BrowserProxyConfig | null> => {
    try {
      const parsed = JSON.parse(await readFile(proxyPath, "utf8")) as Partial<BrowserProxyConfig>;
      if (typeof parsed.server !== "string" || parsed.server.length === 0) return null;
      return {
        server: parsed.server,
        ...(typeof parsed.username === "string" && parsed.username
          ? { username: parsed.username }
          : {}),
        ...(typeof parsed.password === "string" && parsed.password
          ? { password: parsed.password }
          : {}),
      };
    } catch {
      return null;
    }
  };
  let proxy: BrowserProxyConfig | null = yield* Effect.promise(readProxy);
  const stateListeners = new Set<(state: BrowserLiveState) => void>();

  // Браузер не в образе: машина ставит его при первом использовании
  // (browserSetup.ts). Свой бинарь (UNO_WORK_BROWSER_EXECUTABLE) — ставить нечего.
  const setupPaths = process.env[SERVER_BROWSER_EXECUTABLE_ENV]?.trim()
    ? null
    : browserSetupPathsFromEnv();
  const setup: BrowserSetupController | null = setupPaths
    ? makeBrowserSetupController({
        paths: setupPaths,
        isInstalled: async () => {
          const { chromium } = await import("playwright-core");
          return isChromiumInstalled(chromium.executablePath(), setupPaths.browsersDir);
        },
      })
    : null;
  const setupState = (): BrowserLiveSetup => setup?.current() ?? READY_SETUP;
  /** Страницы, которые человек открыл, пока браузер ставился: откроются сами. */
  const pendingOpens = new Map<
    string,
    { readonly context: BrowserBridgeRequestContext; readonly url: string }
  >();

  const pageSnapshot = (entry: PageEntry): BrowserLivePage => ({
    pageId: entry.pageId,
    url: entry.page.isClosed() ? "" : entry.page.url(),
    title: entry.title,
    ...(entry.context ? { context: entry.context } : {}),
    control: entry.control,
    help: entry.help,
    attention: entry.attention,
    agentWaiting: entry.agentWaiting > 0,
    width: entry.viewport.width,
    height: entry.viewport.height,
  });

  // Демон, который сам раздаёт веб-клиент, — машина в облаке: браузер
  // агентов здесь (то же правило, что в browserCommandRouter).
  const agentsBrowseHere = config.mode === "web";

  const snapshot = (): BrowserLiveState => ({
    agentsBrowseHere,
    location: {
      machine,
      publicIp: exit?.ip ?? null,
      display: displayMode,
      running: pagesById.size > 0,
      country: exit?.country ?? null,
      proxy: proxy ? { server: proxy.server, username: proxy.username ?? null } : null,
    },
    setup: setupState(),
    pages: [...pagesById.values()].map(pageSnapshot),
  });

  const emitState = () => {
    if (stateListeners.size === 0) return;
    const state = snapshot();
    for (const listener of stateListeners) listener(state);
  };

  const refreshPublicIp = (force = false) => {
    if (!force && exit && Date.now() - exit.at < PUBLIC_IP_TTL_MS) return;
    const running = Effect.runSync(Ref.get(contextRef));
    // С прокси адрес машины — не тот, что видят сайты: пока браузер не
    // запущен, честнее не показывать ничего.
    if (proxy && !running) {
      exit = null;
      emitState();
      return;
    }
    // Метка ставится до ответа — параллельные подписки не спрашивают дважды.
    exit = { ip: exit?.ip ?? null, country: exit?.country ?? null, at: Date.now() };
    void lookupExit(proxy ? running : null).then((value) => {
      exit = { ...value, at: Date.now() };
      emitState();
    });
  };

  const removeEntry = (entry: PageEntry) => {
    if (pagesById.get(entry.pageId) !== entry) return;
    pagesById.delete(entry.pageId);
    if (pagesByContextKey.get(entry.key) === entry) pagesByContextKey.delete(entry.key);
    // Закрытая страница больше не держит ни агента, ни зрителей.
    for (const wake of entry.controlWaiters) wake();
    entry.controlWaiters.clear();
    entry.frameListeners.clear();
    emitState();
  };

  const ensureCdp = async (entry: PageEntry): Promise<CDPSession> => {
    if (entry.cdp) return entry.cdp;
    const cdp = await entry.page.context().newCDPSession(entry.page);
    // Страница всегда «в фокусе»: каретка и клавиатура работают, даже когда
    // окно на виртуальном экране не активное (или браузер headless).
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    cdp.on("Page.screencastFrame", (payload) => {
      void cdp
        .send("Page.screencastFrameAck", { sessionId: payload.sessionId })
        .catch(() => undefined);
      const frame: BrowserLiveFrame = {
        pageId: entry.pageId,
        data: payload.data,
        width: Math.max(1, Math.round(payload.metadata.deviceWidth)),
        height: Math.max(1, Math.round(payload.metadata.deviceHeight)),
      };
      entry.lastFrame = frame;
      for (const listener of entry.frameListeners) listener(frame);
    });
    entry.cdp = cdp;
    return cdp;
  };

  const startScreencast = async (entry: PageEntry) => {
    if (entry.screencasting || entry.page.isClosed()) return;
    entry.screencasting = true;
    try {
      const cdp = await ensureCdp(entry);
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: VIEWPORT.width * 2,
        maxHeight: VIEWPORT.height * 2,
        everyNthFrame: 1,
      });
    } catch {
      entry.screencasting = false;
    }
  };

  const registerPage = (
    page: Page,
    key: string,
    context: BrowserBridgeRequestContext | undefined,
    semaphore: Semaphore.Semaphore,
  ): PageEntry => {
    const entry: PageEntry = {
      pageId: `pg_${randomBytes(9).toString("base64url")}`,
      key,
      page,
      semaphore,
      inputSemaphore: Semaphore.makeUnsafe(1),
      context,
      viewport: { ...VIEWPORT },
      title: "",
      control: "agent",
      help: null,
      attention: 0,
      agentWaiting: 0,
      controlWaiters: new Set(),
      frameListeners: new Set(),
      lastFrame: null,
      cdp: null,
      screencasting: false,
    };
    pagesById.set(entry.pageId, entry);
    const refreshTitle = () => {
      void page
        .title()
        .then((title) => {
          entry.title = title;
          emitState();
        })
        .catch(() => undefined);
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) emitState();
    });
    page.on("load", refreshTitle);
    page.on("domcontentloaded", refreshTitle);
    page.on("close", () => removeEntry(entry));
    // Окна, которые открывает сайт (OAuth-попапы, target=_blank), — отдельные
    // вкладки того же чата: закрыть их за сайт нельзя, иначе логин через
    // попап сломается. Агент их не адресует, а человек видит и может рулить.
    page.on("popup", (popup) => {
      const popupEntry = registerPage(
        popup,
        `${key}\u0000popup:${randomBytes(6).toString("hex")}`,
        context,
        Semaphore.makeUnsafe(1),
      );
      popupEntry.attention = 1;
      emitState();
    });
    return entry;
  };

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
    const forceHeadless = process.env[SERVER_BROWSER_HEADLESS_ENV] === "1";
    let displayVar = forceHeadless ? undefined : process.env.DISPLAY?.trim() || undefined;
    if (!forceHeadless && !displayVar && process.platform === "linux") {
      if (!display || display.process.exitCode !== null) {
        display = yield* Effect.promise(() => startVirtualDisplay());
      }
      displayVar = display?.display;
    }
    const headless = displayVar === undefined;
    proxy = yield* Effect.promise(readProxy);
    const launchWith = (channel: "chromium" | undefined) =>
      playwright.chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: VIEWPORT,
        ...(executablePath ? { executablePath } : {}),
        ...(channel ? { channel } : {}),
        ...(headless ? {} : { env: { ...process.env, DISPLAY: displayVar } }),
        ...(proxy
          ? {
              proxy: {
                server: proxy.server,
                ...(proxy.username ? { username: proxy.username } : {}),
                ...(proxy.password ? { password: proxy.password } : {}),
              },
            }
          : {}),
        args: [
          `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
          // Невидимая вкладка не должна замирать: её смотрят через screencast.
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
        ],
      });
    const launched = yield* Effect.tryPromise({
      // Headless — полный Chromium в новом headless-режиме (channel
      // "chromium"): install.sh ставит его без отдельной headless-оболочки, и
      // сайтам его сложнее отличить. Нет полного — пробуем оболочку.
      try: () =>
        headless && !executablePath
          ? launchWith("chromium").catch((cause: unknown) =>
              /executable doesn't exist/i.test(String(cause))
                ? launchWith(undefined)
                : Promise.reject(cause),
            )
          : launchWith(undefined),
      catch: (cause) => new ServerBrowserCommandError({ message: launchErrorMessage(cause) }),
    });
    displayMode = headless ? "headless" : "headful";
    // Headful persistent context открывает стартовую вкладку about:blank —
    // она ничья, уберём, чтобы не висела в окне.
    for (const stray of launched.pages()) {
      void stray.close().catch(() => undefined);
    }
    launched.on("close", () => {
      for (const entry of pagesById.values()) removeEntry(entry);
    });
    return launched;
  });

  const getBrowserContext = launchSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const existing = yield* Ref.get(contextRef);
      if (existing && existing.browser()?.isConnected() !== false) {
        return existing;
      }
      pagesByContextKey.clear();
      pagesById.clear();
      const launched = yield* launch;
      yield* Ref.set(contextRef, launched);
      refreshPublicIp(true);
      return launched;
    }),
  );

  const getPageEntry = (
    context: BrowserBridgeRequestContext | undefined,
  ): Effect.Effect<PageEntry, ServerBrowserCommandError> =>
    Effect.gen(function* () {
      const browserContext = yield* getBrowserContext;
      const normalized = context ? normalizeBridgeRequestContext(context) : undefined;
      const key = pageKeyFor(normalized);
      const existing = pagesByContextKey.get(key);
      if (existing && !existing.page.isClosed()) {
        return existing;
      }
      const page = yield* Effect.tryPromise({
        try: () => browserContext.newPage(),
        catch: (cause) => new ServerBrowserCommandError({ message: commandErrorMessage(cause) }),
      });
      const semaphore = existing?.semaphore ?? (yield* Semaphore.make(1));
      const entry = registerPage(page, key, normalized, semaphore);
      pagesByContextKey.set(key, entry);
      emitState();
      return entry;
    });

  /**
   * Страница чата, когда браузер поднимется: запуск Chromium или первая
   * вкладка сразу после установки иногда не выходят с первого раза — пробуем
   * ещё раз в секунду, но не дольше SERVER_BROWSER_READY_RETRY_MS. Нет
   * самого Chromium — ждать нечего.
   */
  const getPageEntryWhenReady = (
    context: BrowserBridgeRequestContext | undefined,
  ): Effect.Effect<PageEntry, ServerBrowserCommandError> => {
    const deadline = Date.now() + SERVER_BROWSER_READY_RETRY_MS;
    const attempt = (): Effect.Effect<PageEntry, ServerBrowserCommandError> =>
      getPageEntry(context).pipe(
        Effect.catch((error: ServerBrowserCommandError) =>
          error.message === CHROMIUM_MISSING_ERROR ||
          Date.now() + SERVER_BROWSER_READY_RETRY_STEP_MS > deadline
            ? Effect.fail(error)
            : Effect.logWarning("machine browser not ready yet, retrying", {
                error: error.message,
              }).pipe(
                Effect.andThen(Effect.sleep(Duration.millis(SERVER_BROWSER_READY_RETRY_STEP_MS))),
                Effect.andThen(Effect.suspend(attempt)),
              ),
        ),
      );
    return attempt();
  };

  /**
   * Дождаться конца установки браузера (готов или не вышло), не дольше
   * limitMs. Возвращает то, что есть к этому моменту.
   */
  const waitForSetup = (limitMs: number): Promise<BrowserLiveSetup> =>
    new Promise((resolve) => {
      if (!setup) {
        resolve(READY_SETUP);
        return;
      }
      const controller = setup;
      let settled = false;
      const cleanups: Array<() => void> = [];
      const finish = (value: BrowserLiveSetup) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) cleanup();
        resolve(value);
      };
      const check = (value: BrowserLiveSetup) => {
        if (value.status === "ready" || value.status === "failed") finish(value);
      };
      cleanups.push(controller.onChange(check));
      const poll = setInterval(() => {
        void controller.refresh().then(check, () => undefined);
      }, 1_000);
      cleanups.push(() => clearInterval(poll));
      const timer = setTimeout(() => finish(controller.current()), limitMs);
      cleanups.push(() => clearTimeout(timer));
      check(controller.current());
    });

  /** Ждать, пока человек вернёт браузер. false — не дождались за timeoutMs. */
  /** Ждать сигнала «браузер вернули агенту» не дольше timeoutMs. */
  const awaitHandBack = (entry: PageEntry, timeoutMs: number) =>
    Effect.callback<void>((resume) => {
      const wake = () => resume(Effect.void);
      entry.controlWaiters.add(wake);
      return Effect.sync(() => {
        entry.controlWaiters.delete(wake);
      });
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));

  /** Ждать, пока человек вернёт браузер. false — не дождались за timeoutMs. */
  const waitForAgentControl = (entry: PageEntry, timeoutMs: number) =>
    Effect.gen(function* () {
      if (entry.control === "agent") return true;
      entry.agentWaiting += 1;
      emitState();
      // ensuring: агент мог бросить ожидание (оборвался запрос) — флаг
      // «агент ждёт» не должен зависнуть в интерфейсе.
      const released = yield* awaitHandBack(entry, timeoutMs).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.agentWaiting = Math.max(0, entry.agentWaiting - 1);
            emitState();
          }),
        ),
      );
      return Option.isSome(released);
    });

  const requestHelp = (
    input: BrowserAutomationCommandInput,
    context: BrowserBridgeRequestContext | undefined,
    timeoutMs: number,
  ) =>
    Effect.gen(function* () {
      const entry = yield* getPageEntry(context);
      entry.help = {
        reason: (input.text ?? "").trim(),
        requestedAt: new Date().toISOString(),
      };
      entry.attention += 1;
      emitState();
      // Помощь закончена, когда управление вернулось агенту: человек взял
      // браузер и отдал, либо нажал «Готово», не беря. Агент бросил ожидание —
      // плашка тоже уходит.
      const handedBack = yield* awaitHandBack(entry, timeoutMs).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.help = null;
            emitState();
          }),
        ),
      );
      if (Option.isNone(handedBack)) {
        return yield* new ServerBrowserCommandError({
          message: `Nobody answered within ${Math.round(timeoutMs / 60_000)} min. Tell the person in chat what you need and continue with something else.`,
        });
      }
      if (entry.page.isClosed()) {
        return yield* new ServerBrowserCommandError({
          message: "The person closed this page.",
        });
      }
      return {
        handedBack: true,
        url: entry.page.url(),
        title: yield* Effect.promise(() => entry.page.title().catch(() => "")),
      };
    });

  const dispatch = (
    input: BrowserAutomationCommandInput,
    context: BrowserBridgeRequestContext | undefined,
    timeoutMs: number,
  ): Effect.Effect<unknown, ServerBrowserCommandError> =>
    Effect.gen(function* () {
      // Автозаполнение из вкладки live view адресовано конкретной странице
      // (например, попапу входа), а не основной странице чата.
      const addressed =
        input.command === "fillCredential" && input.tabId ? pagesById.get(input.tabId) : undefined;
      const entry =
        addressed && !addressed.page.isClosed() ? addressed : yield* getPageEntry(context);
      if (!OBSERVE_COMMANDS.has(input.command)) {
        const mayProceed = yield* waitForAgentControl(entry, timeoutMs);
        if (!mayProceed) {
          return yield* new ServerBrowserCommandError({ message: HUMAN_IN_CONTROL_ERROR });
        }
      }
      if (input.command === "openUrl" || input.command === "navigate") {
        // Агент открыл страницу — вкладка выходит на передний план в приложении.
        entry.attention += 1;
        emitState();
      }
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
      // Браузер ещё не поставлен: запускаем установку и ждём её (обычно
      // ~30–45 с), чтобы первая же команда прошла. Затянулась — отвечаем
      // агенту, когда повторить, а не держим команду бесконечно.
      if (setup && setup.current().status !== "ready") {
        const started = yield* Effect.promise(() =>
          setup.ensure({ context }).catch(
            (cause: unknown): BrowserLiveSetup => ({
              ...setup.current(),
              status: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
        const current =
          started.status === "installing" || started.status === "missing"
            ? yield* Effect.promise(() => waitForSetup(SERVER_BROWSER_SETUP_WAIT_MS))
            : started;
        if (current.status !== "ready") {
          return { ok: false, commandId, error: setupMessageForAgent(current) };
        }
      }
      // Браузер ещё не запущен (или только что поставлен): поднять его и
      // вкладку чата до отсчёта таймаута команды, с повторами.
      if (input.command !== "requestHelp") {
        const warm = yield* getPageEntryWhenReady(context).pipe(
          Effect.map(() => null),
          Effect.catch((error: ServerBrowserCommandError) => Effect.succeed(error.message)),
        );
        if (warm !== null) return { ok: false, commandId, error: warm };
      }
      const timeoutMs = commandTimeoutMs(input);
      const attempt: Effect.Effect<unknown, ServerBrowserCommandError> =
        input.command === "requestHelp"
          ? requestHelp(input, context, timeoutMs)
          : dispatch(input, context, timeoutMs).pipe(
              // Умершая страница/браузер: одно пересоздание (getPageEntry заметит
              // isClosed/disconnected) и повтор.
              Effect.catch((error) =>
                isClosedPageError(error) ? dispatch(input, context, timeoutMs) : Effect.fail(error),
              ),
            );
      // Внешний потолок чуть выше внутренних ожиданий: сообщение «человек
      // рулит»/«никто не ответил» должно успеть дойти вместо голого таймаута.
      const outcome: BrowserAutomationCommandResult = yield* attempt.pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs + 2_000)),
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

  const shutdownBrowser = Effect.gen(function* () {
    const existing = yield* Ref.get(contextRef);
    if (!existing) return;
    yield* Ref.set(contextRef, null);
    for (const entry of pagesById.values()) removeEntry(entry);
    pagesByContextKey.clear();
    yield* Effect.promise(() => existing.close().catch(() => undefined));
  });

  const liveError = (detail: string) => new BrowserLiveError({ detail });

  /** Страница чата, которую открыл человек: рулит он, пока не отдаст агенту. */
  const openForPerson = (context: BrowserBridgeRequestContext, target: string) =>
    Effect.gen(function* () {
      const entry = yield* getPageEntryWhenReady(context).pipe(
        Effect.mapError((error) => liveError(error.message)),
      );
      entry.control = "human";
      entry.attention += 1;
      emitState();
      if (target !== "") {
        yield* livePromise(() => entry.page.goto(target, { waitUntil: "domcontentloaded" }));
      }
      return entry.pageId;
    });

  const requirePage = (pageId: string) =>
    Effect.suspend(() => {
      const entry = pagesById.get(pageId);
      return entry && !entry.page.isClosed()
        ? Effect.succeed(entry)
        : Effect.fail(liveError("This page is closed."));
    });

  const requireHuman = (entry: PageEntry) =>
    entry.control === "human"
      ? Effect.void
      : Effect.fail(liveError("Take control of the browser first."));

  const livePromise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => liveError(cause instanceof Error ? cause.message : String(cause)),
    });

  const live: ServerBrowserLiveShape = {
    state: Effect.sync(snapshot),
    changes: Stream.callback<BrowserLiveState>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (state: BrowserLiveState) => {
            Queue.offerUnsafe(queue, state);
          };
          stateListeners.add(listener);
          refreshPublicIp();
          Queue.offerUnsafe(queue, snapshot());
          return listener;
        }),
        (listener) => Effect.sync(() => stateListeners.delete(listener)),
      ),
    ),
    frames: (pageId) =>
      Stream.unwrap(
        Effect.map(requirePage(pageId), (entry) =>
          Stream.callback<BrowserLiveFrame>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                // Зрителю важен только последний кадр: медленный канал не
                // должен копить очередь из устаревших картинок.
                const listener = (frame: BrowserLiveFrame) => {
                  Queue.offerUnsafe(queue, frame);
                };
                entry.frameListeners.add(listener);
                if (entry.lastFrame) Queue.offerUnsafe(queue, entry.lastFrame);
                void startScreencast(entry);
                return listener;
              }),
              (listener) =>
                Effect.sync(() => {
                  entry.frameListeners.delete(listener);
                  if (entry.frameListeners.size === 0) stopScreencast(entry);
                }),
            ),
          ).pipe(Stream.buffer({ capacity: 2, strategy: "sliding" })),
        ),
      ),
    input: (pageId, event) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(pageId);
        yield* requireHuman(entry);
        const { page } = entry;
        const apply = livePromise(async () => {
          switch (event.type) {
            case "mouse": {
              await page.mouse.move(event.x, event.y);
              if (event.action === "down") {
                await page.mouse.down({
                  button: event.button ?? "left",
                  clickCount: event.clickCount ?? 1,
                });
              } else if (event.action === "up") {
                await page.mouse.up({
                  button: event.button ?? "left",
                  clickCount: event.clickCount ?? 1,
                });
              }
              return;
            }
            case "wheel":
              await page.mouse.move(event.x, event.y);
              await page.mouse.wheel(event.deltaX, event.deltaY);
              return;
            case "key": {
              if (IGNORED_KEYS.has(event.key)) return;
              try {
                if (event.action === "down") await page.keyboard.down(event.key);
                else await page.keyboard.up(event.key);
              } catch (cause) {
                // Незнакомая playwright клавиша — не повод рвать ввод.
                if (!/Unknown key/i.test(String(cause))) throw cause;
              }
              return;
            }
            case "text":
              await page.keyboard.insertText(event.text);
              return;
          }
        });
        yield* entry.inputSemaphore.withPermits(1)(apply);
      }),
    setControl: (pageId, control) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(pageId);
        entry.control = control;
        if (control === "agent") {
          // Агент работает в своём размере: координаты и скриншоты не прыгают.
          if (
            entry.viewport.width !== VIEWPORT.width ||
            entry.viewport.height !== VIEWPORT.height
          ) {
            entry.viewport = { ...VIEWPORT };
            yield* Effect.promise(() =>
              entry.page.setViewportSize(VIEWPORT).catch(() => undefined),
            );
          }
          for (const wake of entry.controlWaiters) wake();
        }
        emitState();
        return snapshot();
      }),
    navigate: (input) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(input.pageId);
        yield* requireHuman(entry);
        const { page } = entry;
        yield* livePromise(async () => {
          switch (input.action) {
            case "goto": {
              const url = input.url?.trim() ?? "";
              if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) addresses open here.");
              await page.goto(url, { waitUntil: "domcontentloaded" });
              return;
            }
            case "back":
              await page.goBack();
              return;
            case "forward":
              await page.goForward();
              return;
            case "reload":
              await page.reload();
              return;
          }
        });
      }),
    open: (context, url) =>
      Effect.gen(function* () {
        const target = url.trim();
        if (target !== "" && !/^https?:\/\//i.test(target)) {
          return yield* liveError("Only http(s) addresses open here.");
        }
        if (setup && setup.current().status !== "ready") {
          const current = yield* Effect.tryPromise({
            try: () => setup.ensure({ context, force: true }),
            catch: (cause) => liveError(cause instanceof Error ? cause.message : String(cause)),
          });
          if (current.status !== "ready") {
            // Страница откроется сама, когда браузер встанет; пока приложение
            // показывает установку.
            pendingOpens.set(pageKeyFor(normalizeBridgeRequestContext(context)), {
              context,
              url: target,
            });
            return { pageId: BROWSER_LIVE_SETUP_PAGE_ID };
          }
        }
        return { pageId: yield* openForPerson(context, target) };
      }),
    close: (pageId) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(pageId);
        yield* livePromise(() => entry.page.close());
      }),
    resize: (pageId, width, height) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(pageId);
        yield* requireHuman(entry);
        const size = {
          width: Math.min(MAX_VIEWPORT.width, Math.max(MIN_VIEWPORT.width, Math.round(width))),
          height: Math.min(MAX_VIEWPORT.height, Math.max(MIN_VIEWPORT.height, Math.round(height))),
        };
        if (size.width === entry.viewport.width && size.height === entry.viewport.height) return;
        entry.viewport = size;
        yield* livePromise(() => entry.page.setViewportSize(size));
        emitState();
      }),
    copySelection: (pageId) =>
      Effect.gen(function* () {
        const entry = yield* requirePage(pageId);
        const text = yield* livePromise(() => entry.page.evaluate(SELECTION_SCRIPT));
        return typeof text === "string" ? text : "";
      }),
    setup: Effect.gen(function* () {
      if (setup) {
        yield* Effect.tryPromise({
          try: () => setup.ensure({ force: true }),
          catch: (cause) => liveError(cause instanceof Error ? cause.message : String(cause)),
        });
      }
      return snapshot();
    }),
    setProxy: (input) =>
      Effect.gen(function* () {
        const server = input.server.trim();
        const next: BrowserProxyConfig | null =
          server === ""
            ? null
            : {
                server,
                ...(input.username?.trim() ? { username: input.username.trim() } : {}),
                // Пустой пароль при правке того же прокси не затирает сохранённый.
                ...(input.password
                  ? { password: input.password }
                  : proxy?.password &&
                      proxy.server === server &&
                      (proxy.username ?? "") === (input.username?.trim() ?? "")
                    ? { password: proxy.password }
                    : {}),
              };
        if (next) {
          const problem = proxyConfigProblem(next);
          if (problem) return yield* liveError(problem);
        }
        yield* livePromise(async () => {
          await mkdir(dirname(proxyPath), { recursive: true, mode: 0o700 });
          const temp = `${proxyPath}.${randomBytes(6).toString("hex")}.tmp`;
          await writeFile(temp, JSON.stringify(next ?? {}), { mode: 0o600 });
          await rename(temp, proxyPath);
        });
        proxy = next;
        exit = null;
        // Прокси задаётся при запуске браузера: перезапускаем, логины профиля
        // остаются (он на диске). Следующая команда поднимет браузер заново.
        yield* shutdownBrowser;
        emitState();
        return snapshot();
      }),
  };

  if (setup) {
    setup.onChange((next) => {
      emitState();
      if (next.status !== "ready" || pendingOpens.size === 0) return;
      const opens = [...pendingOpens.values()];
      pendingOpens.clear();
      for (const pending of opens) {
        void Effect.runPromise(openForPerson(pending.context, pending.url).pipe(Effect.ignore));
      }
    });
    // Установка могла идти до рестарта демона — подхватываем её прогресс.
    void setup.refresh();
  }

  const shutdown = Effect.gen(function* () {
    setup?.stop();
    yield* shutdownBrowser;
    if (display) {
      display.process.kill("SIGTERM");
      display = null;
    }
  });

  yield* Effect.addFinalizer(() => shutdown.pipe(Effect.timeout("5 seconds"), Effect.ignore));

  return { execute, live, shutdown } satisfies ServerBrowserShape;
});

export const ServerBrowserLive = Layer.effect(ServerBrowser, makeServerBrowser);

/** Live view без браузера — для тестов и стабов. */
export const unavailableServerBrowserLive: ServerBrowserLiveShape = {
  state: Effect.succeed({
    agentsBrowseHere: false,
    location: {
      machine: "test",
      publicIp: null,
      display: "headless",
      running: false,
      country: null,
      proxy: null,
    },
    setup: READY_SETUP,
    pages: [],
  }),
  changes: Stream.empty,
  frames: () => Stream.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  input: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  setControl: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  navigate: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  open: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  close: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  resize: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  copySelection: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  setProxy: () => Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
  setup: Effect.fail(new BrowserLiveError({ detail: "No browser in tests." })),
};

/** Стаб для тестов: серверного браузера нет, любая команда — ошибка. */
export const ServerBrowserTest = Layer.succeed(ServerBrowser, {
  execute: () =>
    Effect.succeed({
      ok: false,
      commandId: "test",
      error: "Server-side browser is unavailable in tests.",
    }),
  live: unavailableServerBrowserLive,
  shutdown: Effect.void,
});
