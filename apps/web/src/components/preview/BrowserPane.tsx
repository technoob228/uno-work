import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreVerticalIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
  MonitorSmartphoneIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BrowserAutomationCommandInput,
  BrowserCredentialRecord,
  CredentialMetadata,
} from "@t3tools/contracts";
import {
  buildClickSelectorScript,
  buildClickTextScript,
  buildFillLoginScript,
  buildLoginCaptureScript,
  buildTypeScript,
} from "@t3tools/shared/browserAutomationScripts";
import {
  emptyFrameMessage,
  isEmptyScreenshot,
  screenshotBytes,
  type ScreenshotResultData,
} from "@t3tools/shared/browserScreenshot";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isElectron } from "../../env";
import {
  isBrowserExtensionConnected,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { cn } from "../../lib/utils";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  clearBrowserAutomationHandler,
  clearBrowserTabAutomationHandler,
  setBrowserAutomationHandler,
  setBrowserTabAutomationHandler,
} from "./BrowserAutomationRegistry";
import { CompanionExtensionPanel } from "./CompanionExtensionPanel";
import { browserPartitionForScope, browserUrlOrigin, normalizeBrowserUrl } from "./browserUrl";
import {
  isBrowserTab,
  NO_PROJECT_KEY,
  usePreviewPane,
  type PreviewFile,
} from "./PreviewPaneContext";
import { projectScopeKey, scopeOfKey, visibleScopeKeys } from "./previewTabScopes";

/**
 * Подмножество методов Electron `<webview>`, которое использует тулбар.
 * Полные типы живут в `electron`, но web-пакет не зависит от него.
 */
interface ElectronWebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache?: () => void;
  stop(): void;
  setZoomFactor?: (factor: number) => void;
  capturePage?: () => Promise<{
    toDataURL: () => string;
    isEmpty?: () => boolean;
    getSize?: () => { width: number; height: number };
  }>;
  insertText?: (text: string) => Promise<void>;
  sendInputEvent?: (event: Record<string, unknown>) => void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

interface WebviewNavigateEvent extends Event {
  url: string;
  isMainFrame?: boolean;
}

interface WebviewTitleEvent extends Event {
  title: string;
}

interface WebviewConsoleEvent extends Event {
  message: string;
}

interface WebviewFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

const BROWSER_CREDENTIALS_QUERY_KEY = ["vaultCredentials"] as const;
const LEGACY_CREDENTIALS_QUERY_KEY = ["legacyDesktopCredentials"] as const;
const BROWSER_RECENTS_STORAGE_KEY = "uno_browser_recent_urls";
const MAX_BROWSER_RECENTS = 8;
const DEFAULT_ZOOM_FACTOR = 1;
const ZOOM_STEP = 0.1;
const SCREENSHOT_CAPTURE_ATTEMPTS = 3;
const SCREENSHOT_RETRY_DELAY_MS = 350;

function readBrowserRecents(): readonly string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BROWSER_RECENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_BROWSER_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function rememberBrowserUrl(url: string): void {
  if (typeof window === "undefined" || !url) return;
  const recents = readBrowserRecents().filter((entry) => entry !== url);
  window.localStorage.setItem(
    BROWSER_RECENTS_STORAGE_KEY,
    JSON.stringify([url, ...recents].slice(0, MAX_BROWSER_RECENTS)),
  );
}

/**
 * Снимок видимой области вкладки с валидацией кадра.
 *
 * `capturePage()` у скрытой webview (`visibility: hidden`, свёрнутое окно,
 * выбран другой проект) отдаёт пустой `NativeImage`: `toDataURL()` возвращает
 * голый префикс без payload. Раньше такой кадр уходил наружу как успех — тут
 * он распознаётся, пара повторов даёт композитору шанс отрисовать кадр, а в
 * конце команда честно падает с `empty_frame`.
 */
async function capturePanelScreenshot(view: ElectronWebviewElement): Promise<ScreenshotResultData> {
  if (!view.capturePage) throw new Error("capturePage is unavailable.");
  let dataUrl = "";
  let attempt = 0;
  while (attempt < SCREENSHOT_CAPTURE_ATTEMPTS) {
    attempt += 1;
    // Фокус подталкивает Chromium отрисовать кадр, если вкладка не в фокусе.
    view.focus?.();
    const image = await view.capturePage();
    dataUrl = image.toDataURL();
    const size = image.getSize?.();
    if (!isEmptyScreenshot(dataUrl) && image.isEmpty?.() !== true) {
      return {
        dataUrl,
        bytes: screenshotBytes(dataUrl),
        ...(size ? { width: size.width, height: size.height } : {}),
        fullPage: false,
        capturedBy: "panel",
        ...(view.getURL?.() ? { url: view.getURL() } : {}),
      };
    }
    if (attempt < SCREENSHOT_CAPTURE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    emptyFrameMessage({ capturedBy: "panel", attempts: attempt, bytes: screenshotBytes(dataUrl) }),
  );
}

/**
 * Сохранённые логины из хранилища демона (`vault.*`) — единый источник и для
 * браузерной версии, и для десктопа: хранилище держит демон, а не оболочка,
 * поэтому один раз введённый логин виден в обоих режимах. Пароли сюда не
 * приходят: в списке только метаданные.
 */
export function useVaultCredentials() {
  return useQuery({
    queryKey: BROWSER_CREDENTIALS_QUERY_KEY,
    queryFn: async (): Promise<readonly CredentialMetadata[]> => {
      const api = readLocalApi();
      if (!api) return [];
      return api.vault.list();
    },
    staleTime: 10_000,
  });
}

export function useInvalidateBrowserCredentials() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: BROWSER_CREDENTIALS_QUERY_KEY }),
    [queryClient],
  );
}

/**
 * Логины из старого локального хранилища десктопа (Electron safeStorage). Живёт
 * только ради переноса в общий vault — новые записи туда больше не пишутся.
 */
export function useLegacyDesktopCredentials() {
  return useQuery({
    queryKey: LEGACY_CREDENTIALS_QUERY_KEY,
    queryFn: async (): Promise<readonly BrowserCredentialRecord[]> => {
      if (!window.desktopBridge) return [];
      return window.desktopBridge.listBrowserCredentials();
    },
    enabled: isElectron,
    staleTime: 10_000,
  });
}

/** Совпадение по origin: у креда хранится URL, сравниваем нормализованные origin. */
export function matchCredentialsForOrigin(input: {
  credentials: readonly CredentialMetadata[] | undefined;
  origin: string | null;
}): readonly CredentialMetadata[] {
  if (!input.credentials || !input.origin) return [];
  return input.credentials.filter(
    (credential) => browserUrlOrigin(credential.url) === input.origin,
  );
}

/**
 * Все браузерные вкладки держатся смонтированными (скрытые — `visibility`),
 * чтобы webview не терял состояние страницы при переключении вкладок.
 * Вкладки чужих (не активных сейчас) проектов тоже остаются жить: команды
 * харнесса из другого проекта исполняются в их webview, а не в текущем.
 */
export function BrowserViews({ activeId }: { activeId: string | null }) {
  const { statesByScopeKey, currentProjectKey, currentChatThreadId, activeFileId } =
    usePreviewPane();
  const visibleKeys = new Set(
    visibleScopeKeys({ projectKey: currentProjectKey, threadId: currentChatThreadId }),
  );
  const views: ReactNode[] = [];
  for (const [scopeKey, bucket] of Object.entries(statesByScopeKey)) {
    const tabs = bucket.files.filter(isBrowserTab);
    if (tabs.length === 0) continue;
    // Таргет автоматизации бакета: активная браузерная вкладка (активная
    // вкладка хранится в проектном бакете вида), иначе последняя открытая —
    // команды работают, даже когда активен файл-превью.
    const automationTabId =
      activeFileId && tabs.some((tab) => tab.id === activeFileId)
        ? activeFileId
        : tabs[tabs.length - 1]!.id;
    for (const tab of tabs) {
      views.push(
        <BrowserView
          // Один и тот же файл может быть открыт в бакетах разных тредов —
          // ключ обязан включать бакет, иначе React увидит дубль.
          key={`${scopeKey}::${tab.id}`}
          tab={tab}
          scopeKey={scopeKey}
          projectKey={browserTabProjectKey(tab, scopeKey)}
          visible={visibleKeys.has(scopeKey) && tab.id === activeId}
          automationActive={tab.id === automationTabId}
        />,
      );
    }
  }
  if (views.length === 0) return null;
  return <>{views}</>;
}

/**
 * Проект вкладки — для партиции cookies и подбора сохранённых кредов. У вкладок,
 * восстановленных из localStorage, поля нет: тогда берём проект из бакета, а у
 * глобальных вкладок проекта нет вовсе (аккаунтная партиция).
 */
function browserTabProjectKey(tab: PreviewFile, scopeKey: string): string {
  if (tab.projectKey) return tab.projectKey;
  return scopeOfKey(scopeKey) === "project"
    ? scopeKey.slice(projectScopeKey("").length)
    : NO_PROJECT_KEY;
}

function BrowserView({
  tab,
  scopeKey,
  projectKey,
  visible,
  automationActive,
}: {
  tab: PreviewFile;
  scopeKey: string;
  projectKey: string;
  visible: boolean;
  automationActive: boolean;
}) {
  const { updateBrowserTab, currentChatThreadId, currentChatProjectCwd } = usePreviewPane();
  const browserProfileScope = useSettings((settings) => settings.browserProfileScope);
  const [webviewNode, setWebviewNode] = useState<ElectronWebviewElement | null>(null);
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const readyRef = useRef(false);
  // src выставляется один раз: дальнейшая навигация идёт императивно через
  // loadURL, иначе каждое обновление url перезагружало бы страницу.
  const [mountSrc, setMountSrc] = useState<string>(() => tab.url ?? "");
  // Партиция фиксируется при создании вкладки — менять partition у живого
  // webview Electron запрещает. Считается от проекта самой вкладки, а не от
  // активного на экране: куки/сессии не перетекают между проектами.
  const [partition] = useState<string>(() =>
    browserPartitionForScope({
      scope: browserProfileScope,
      projectKey,
    }),
  );
  // Nonce канала перехвата логина: страница отдаёт пару логин/пароль через
  // console.log с этим префиксом, и только наш слушатель его узнаёт.
  const [captureNonce] = useState<string>(() => `uno-login-capture:${crypto.randomUUID()}:`);
  const [addressValue, setAddressValue] = useState<string>(tab.url ?? "");
  const [addressFocused, setAddressFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoomFactor, setZoomFactor] = useState(DEFAULT_ZOOM_FACTOR);
  const [deviceToolbarOpen, setDeviceToolbarOpen] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [recentUrls, setRecentUrls] = useState<readonly string[]>(() => readBrowserRecents());
  const credentialsQuery = useVaultCredentials();
  const invalidateCredentials = useInvalidateBrowserCredentials();
  // Перехваченный логин, который ещё не сохранён: плашка «Сохранить?» над страницей.
  const [pendingLogin, setPendingLogin] = useState<{
    origin: string;
    username: string;
    password: string;
  } | null>(null);

  const currentUrl = tab.url ?? "";
  const origin = browserUrlOrigin(currentUrl);
  const matchedCredentials = useMemo(
    () => matchCredentialsForOrigin({ credentials: credentialsQuery.data, origin }),
    [credentialsQuery.data, origin],
  );

  // Адресная строка следует за навигацией, пока пользователь её не редактирует.
  useEffect(() => {
    if (!addressFocused) setAddressValue(currentUrl);
  }, [currentUrl, addressFocused]);

  useEffect(() => {
    if (mountSrc || !tab.url) return;
    setMountSrc(tab.url);
  }, [tab.url, mountSrc]);

  useEffect(() => {
    if (!currentUrl || !/^https?:\/\//i.test(currentUrl)) return;
    rememberBrowserUrl(currentUrl);
    setRecentUrls(readBrowserRecents());
  }, [currentUrl]);

  const navigate = useCallback(
    (rawInput: string) => {
      const url = normalizeBrowserUrl(rawInput);
      if (!url) return;
      setLoadError(null);
      updateBrowserTab(scopeKey, tab.id, { url });
      // Веб-режим: webview нет, страницу открывает companion-расширение во
      // вкладке пользователя. Если расширения нет — панель ниже ведёт по
      // установке, адрес при этом сохранён в tab.url.
      if (!isElectron) {
        if (isBrowserExtensionConnected()) {
          void runExtensionBrowserCommand({ command: "openUrl", url }).catch(() => {});
        }
        return;
      }
      const view = webviewRef.current;
      if (view && readyRef.current) {
        void view.loadURL(url).catch(() => {});
      } else {
        setMountSrc(url);
      }
    },
    [scopeKey, tab.id, updateBrowserTab],
  );

  const attachWebview = useCallback((node: HTMLWebViewElement | null) => {
    const view = node as ElectronWebviewElement | null;
    webviewRef.current = view;
    if (!view) readyRef.current = false;
    setWebviewNode(view);
  }, []);

  useEffect(() => {
    const view = webviewNode;
    if (!view) return;

    const syncNavState = () => {
      setCanGoBack(view.canGoBack());
      setCanGoForward(view.canGoForward());
    };
    const onDomReady = () => {
      readyRef.current = true;
      syncNavState();
      // Перехват логина: скрипт идемпотентен, ставим на каждую загрузку.
      void view.executeJavaScript(buildLoginCaptureScript(captureNonce), false).catch(() => {});
    };
    const onConsoleMessage = (event: Event) => {
      const message = (event as WebviewConsoleEvent).message;
      if (typeof message !== "string" || !message.startsWith(captureNonce)) return;
      // Останавливаем всплытие в devtools-консоль хоста: пароль не должен
      // оказаться ни в одном логе.
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      const pageOrigin = browserUrlOrigin(view.getURL?.() || tab.url);
      if (!pageOrigin) return;
      try {
        const parsed = JSON.parse(message.slice(captureNonce.length)) as {
          username?: unknown;
          password?: unknown;
        };
        if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return;
        if (parsed.username.length === 0 || parsed.password.length === 0) return;
        setPendingLogin({
          origin: pageOrigin,
          username: parsed.username,
          password: parsed.password,
        });
      } catch {
        // Не наш формат — игнорируем.
      }
    };
    const onStartLoading = () => setLoading(true);
    const onStopLoading = () => setLoading(false);
    const onNavigate = (event: Event) => {
      const navigateEvent = event as WebviewNavigateEvent;
      if (navigateEvent.isMainFrame === false) return;
      setLoadError(null);
      updateBrowserTab(scopeKey, tab.id, { url: navigateEvent.url });
      syncNavState();
    };
    const onTitleUpdated = (event: Event) => {
      const titleEvent = event as WebviewTitleEvent;
      updateBrowserTab(scopeKey, tab.id, { name: titleEvent.title });
    };
    const onFailLoad = (event: Event) => {
      const failEvent = event as WebviewFailLoadEvent;
      // -3 (ERR_ABORTED) приходит при штатной отмене навигации.
      if (!failEvent.isMainFrame || failEvent.errorCode === -3) return;
      setLoadError(`${failEvent.errorDescription || "Ошибка загрузки"} (${failEvent.errorCode})`);
    };

    view.addEventListener("dom-ready", onDomReady);
    view.addEventListener("console-message", onConsoleMessage);
    view.addEventListener("did-start-loading", onStartLoading);
    view.addEventListener("did-stop-loading", onStopLoading);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitleUpdated);
    view.addEventListener("did-fail-load", onFailLoad);
    return () => {
      view.removeEventListener("dom-ready", onDomReady);
      view.removeEventListener("console-message", onConsoleMessage);
      view.removeEventListener("did-start-loading", onStartLoading);
      view.removeEventListener("did-stop-loading", onStopLoading);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitleUpdated);
      view.removeEventListener("did-fail-load", onFailLoad);
    };
  }, [webviewNode, scopeKey, tab.id, tab.url, captureNonce, updateBrowserTab]);

  /**
   * Заполнение просит СЕРВЕР: пароль лежит в хранилище демона, и клиент его не
   * получает — он присылает только id креда и свою вкладку. Так один и тот же
   * логин работает и в десктопе, и в браузерной версии, и в headless-браузере
   * бокса, а секрет не проходит через RPC-ответ и чат.
   */
  const autofillCredential = useCallback(
    async (credential: CredentialMetadata) => {
      try {
        const result = await ensureLocalApi().vault.fill({
          id: credential.id,
          tabId: tab.id,
          ...(currentChatThreadId ? { threadId: currentChatThreadId } : {}),
          ...(currentChatProjectCwd ? { cwd: currentChatProjectCwd } : {}),
        });
        if (!result.filled) {
          toastManager.add({
            title: "Не удалось заполнить логин",
            description:
              result.error ?? "Откройте форму входа на странице и попробуйте ещё раз.",
            type: "warning",
          });
        }
      } catch (error) {
        toastManager.add({
          title: "Хранилище логинов недоступно",
          description: error instanceof Error ? error.message : String(error),
          type: "error",
        });
      }
    },
    [currentChatProjectCwd, currentChatThreadId, tab.id],
  );

  const savePendingLogin = useCallback(async () => {
    if (!pendingLogin) return;
    const host = (() => {
      try {
        return new URL(pendingLogin.origin).hostname.replace(/^www\./, "");
      } catch {
        return pendingLogin.origin;
      }
    })();
    const existing = (credentialsQuery.data ?? []).find(
      (candidate) =>
        browserUrlOrigin(candidate.url) === pendingLogin.origin &&
        candidate.username === pendingLogin.username,
    );
    try {
      await ensureLocalApi().vault.upsert({
        ...(existing ? { id: existing.id } : {}),
        input: {
          label: host,
          url: pendingLogin.origin,
          username: pendingLogin.username,
          password: pendingLogin.password,
        },
      });
      setPendingLogin(null);
      await invalidateCredentials();
      toastManager.add({
        type: "success",
        title: existing ? `Пароль для ${host} обновлён` : `Логин для ${host} сохранён`,
        description: "Дальше заполняется кнопкой с ключом в адресной строке.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Не удалось сохранить логин",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [credentialsQuery.data, invalidateCredentials, pendingLogin]);

  const handleAutofillClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (matchedCredentials.length === 0) return;
      if (matchedCredentials.length === 1) {
        void autofillCredential(matchedCredentials[0]!);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const picked = await readLocalApi()?.contextMenu.show(
        matchedCredentials.map((credential) => ({
          id: credential.id,
          label: credential.username,
        })),
        { x: rect.left, y: rect.bottom },
      );
      const credential = matchedCredentials.find((entry) => entry.id === picked);
      if (credential) void autofillCredential(credential);
    },
    [matchedCredentials, autofillCredential],
  );

  const openExternal = useCallback(() => {
    if (!currentUrl) return;
    void readLocalApi()?.shell.openExternal(currentUrl);
  }, [currentUrl]);

  const applyZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(2, Math.max(0.3, Number(nextZoom.toFixed(2))));
    setZoomFactor(clamped);
    webviewRef.current?.setZoomFactor?.(clamped);
  }, []);

  const captureScreenshot = useCallback(async () => {
    const view = webviewRef.current;
    const dataUrl = view
      ? await capturePanelScreenshot(view)
          .then((result) => result.dataUrl)
          .catch(() => null)
      : null;
    if (!dataUrl) {
      toastManager.add({
        type: "warning",
        title: "Скриншот недоступен",
        description: "Electron webview не вернул изображение страницы.",
      });
      return null;
    }
    await navigator.clipboard?.writeText(dataUrl).catch(() => undefined);
    toastManager.add({
      type: "success",
      title: "Скриншот страницы готов",
      description: "Data URL скопирован в буфер обмена.",
    });
    return dataUrl;
  }, []);

  const clearBrowserData = useCallback(
    async (kind: "cache" | "cookies" | "all") => {
      if (!window.desktopBridge) return;
      const origin = kind === "cookies" ? (browserUrlOrigin(currentUrl) ?? undefined) : undefined;
      await window.desktopBridge.clearBrowserData({
        partition,
        ...(origin ? { origin } : {}),
        cache: kind === "cache" || kind === "all",
        cookies: kind === "cookies" || kind === "all",
      });
      toastManager.add({
        type: "success",
        title:
          kind === "cache"
            ? "Кэш очищен"
            : kind === "cookies"
              ? "Cookies очищены"
              : "Данные очищены",
      });
    },
    [currentUrl, partition],
  );

  const handleAutomationCommand = useCallback(
    async (input: BrowserAutomationCommandInput): Promise<unknown> => {
      const view = webviewRef.current;
      if (!view) throw new Error("Embedded browser is not mounted.");

      switch (input.command) {
        case "openUrl":
        case "navigate": {
          if (!input.url) throw new Error("Missing url.");
          navigate(input.url);
          return { url: input.url };
        }
        case "state":
          return {
            url: view.getURL?.() || currentUrl,
            title: tab.name,
            canGoBack: view.canGoBack(),
            canGoForward: view.canGoForward(),
            loading,
          };
        case "screenshot":
          return capturePanelScreenshot(view);
        case "click":
          if (input.selector) {
            return view.executeJavaScript(buildClickSelectorScript(input.selector), true);
          }
          if (input.x === undefined || input.y === undefined || !view.sendInputEvent) {
            throw new Error("Click requires selector or x/y coordinates.");
          }
          view.sendInputEvent({
            type: "mouseDown",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
          view.sendInputEvent({
            type: "mouseUp",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
          return { clicked: true, x: input.x, y: input.y };
        case "clickText":
          if (!input.text) throw new Error("Missing text.");
          return view.executeJavaScript(buildClickTextScript(input.text), true);
        case "type":
          if (input.selector) {
            return view.executeJavaScript(
              buildTypeScript(input.selector, input.value ?? input.text ?? ""),
              true,
            );
          }
          if (!view.insertText) throw new Error("insertText is unavailable.");
          await view.insertText(input.value ?? input.text ?? "");
          return { typed: true };
        case "press":
          if (!input.key || !view.sendInputEvent) throw new Error("press requires key support.");
          view.sendInputEvent({ type: "keyDown", keyCode: input.key });
          view.sendInputEvent({ type: "keyUp", keyCode: input.key });
          return { pressed: input.key };
        case "reload":
          if ((input.value ?? input.text) === "force" && view.reloadIgnoringCache) {
            view.reloadIgnoringCache();
          } else {
            view.reload();
          }
          return { reloaded: true };
        case "back":
          if (view.canGoBack()) view.goBack();
          return { canGoBack: view.canGoBack() };
        case "forward":
          if (view.canGoForward()) view.goForward();
          return { canGoForward: view.canGoForward() };
        case "evaluate":
          if (!input.script) throw new Error("Missing script.");
          return view.executeJavaScript(input.script, true);
        case "fillCredential": {
          // Значения подставил сервер по явному действию пользователя
          // (`vault.fill`) — агент такую команду отправить не может.
          if (input.username === undefined || input.password === undefined) {
            throw new Error("fillCredential requires credentials.");
          }
          const filled = await view.executeJavaScript(
            buildFillLoginScript(input.username, input.password),
            true,
          );
          if (filled !== true) throw new Error("Поля логина на странице не найдены.");
          return { filled: true };
        }
      }
    },
    [currentUrl, loading, navigate, tab.name],
  );

  useEffect(() => {
    if (!automationActive) return;
    setBrowserAutomationHandler(scopeKey, handleAutomationCommand);
    return () => {
      clearBrowserAutomationHandler(scopeKey, handleAutomationCommand);
    };
  }, [automationActive, handleAutomationCommand, scopeKey]);

  // Адресация по вкладке: автозаполнение кредов должно попасть именно в ту
  // вкладку, на которой пользователь нажал кнопку, даже если целью автоматизации
  // сейчас выбрана другая.
  useEffect(() => {
    setBrowserTabAutomationHandler(tab.id, handleAutomationCommand);
    return () => {
      clearBrowserTabAutomationHandler(tab.id, handleAutomationCommand);
    };
  }, [handleAutomationCommand, tab.id]);

  return (
    <div
      // Невидимые вкладки прячутся через visibility, а не display: в
      // display:none-поддереве Electron не аттачит новые <webview>, и фоновые
      // вкладки (в т.ч. чужих проектов) переставали бы исполнять команды.
      className={cn(
        "absolute inset-0 z-10 flex flex-col bg-background",
        !visible && "invisible pointer-events-none",
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-2 text-xs">
        <TooltipProvider delay={300} closeDelay={0}>
          <button
            type="button"
            onClick={() => webviewRef.current?.goBack()}
            disabled={!canGoBack}
            aria-label="Назад"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => webviewRef.current?.goForward()}
            disabled={!canGoForward}
            aria-label="Вперёд"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowRightIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (loading) webviewRef.current?.stop();
              else webviewRef.current?.reload();
            }}
            disabled={!mountSrc}
            aria-label={loading ? "Остановить" : "Обновить"}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <XIcon className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
          </button>
          <form
            className="flex min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(addressValue);
              (
                event.currentTarget.elements.namedItem("address") as HTMLInputElement | null
              )?.blur();
            }}
          >
            <input
              name="address"
              type="text"
              value={addressValue}
              onChange={(event) => setAddressValue(event.target.value)}
              onFocus={(event) => {
                setAddressFocused(true);
                event.currentTarget.select();
              }}
              onBlur={() => setAddressFocused(false)}
              placeholder="Введите адрес или запрос"
              autoFocus={!mountSrc}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </form>
          {loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          <button
            type="button"
            onClick={() => applyZoom(zoomFactor - ZOOM_STEP)}
            disabled={!mountSrc}
            aria-label="Уменьшить масштаб"
            title="Уменьшить масштаб"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => applyZoom(DEFAULT_ZOOM_FACTOR)}
            disabled={!mountSrc}
            aria-label="Сбросить масштаб"
            title="Сбросить масштаб"
            className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {Math.round(zoomFactor * 100)}%
          </button>
          <button
            type="button"
            onClick={() => applyZoom(zoomFactor + ZOOM_STEP)}
            disabled={!mountSrc}
            aria-label="Увеличить масштаб"
            title="Увеличить масштаб"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={async (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const choice = await readLocalApi()?.contextMenu.show(
                [
                  { id: "force-reload", label: "Обновить без кэша" },
                  { id: "screenshot", label: "Скриншот страницы" },
                  { id: "responsive", label: "Responsive" },
                  { id: "mobile", label: "Mobile 390x844" },
                  { id: "tablet", label: "Tablet 768x1024" },
                  { id: "desktop", label: "Desktop 1280x800" },
                  { id: "cache", label: "Очистить кэш" },
                  { id: "cookies", label: "Очистить cookies текущего сайта" },
                  { id: "all", label: "Очистить cookies и кэш" },
                ],
                { x: rect.left, y: rect.bottom + 4 },
              );
              if (choice === "force-reload") {
                if (webviewRef.current?.reloadIgnoringCache) {
                  webviewRef.current.reloadIgnoringCache();
                } else webviewRef.current?.reload();
              } else if (choice === "screenshot") {
                void captureScreenshot();
              } else if (choice === "responsive") {
                setDeviceToolbarOpen(true);
                setViewportSize(null);
              } else if (choice === "mobile") {
                setDeviceToolbarOpen(true);
                setViewportSize({ width: 390, height: 844 });
              } else if (choice === "tablet") {
                setDeviceToolbarOpen(true);
                setViewportSize({ width: 768, height: 1024 });
              } else if (choice === "desktop") {
                setDeviceToolbarOpen(true);
                setViewportSize({ width: 1280, height: 800 });
              } else if (choice === "cache" || choice === "cookies" || choice === "all") {
                void clearBrowserData(choice);
              }
            }}
            disabled={!mountSrc}
            aria-label="Дополнительные действия"
            title="Дополнительные действия"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MoreVerticalIcon className="size-3.5" />
          </button>
          {/* Кнопка есть в обеих оболочках: пароль подставляет сервер, поэтому
              заполнение работает и в браузерной версии (через companion), и в
              десктопе, и в headless-браузере бокса. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleAutofillClick}
                  disabled={matchedCredentials.length === 0}
                  aria-label={
                    matchedCredentials.length > 0
                      ? "Заполнить сохранённый логин"
                      : "Нет сохранённых логинов для текущего сайта"
                  }
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <KeyRoundIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="bottom">
              {matchedCredentials.length > 0
                ? "Заполнить логин и пароль"
                : origin
                  ? `Нет сохранённых логинов для ${origin}`
                  : "Откройте сайт, чтобы подобрать сохранённый логин"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={openExternal}
                  disabled={!currentUrl}
                  aria-label="Открыть в системном браузере"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="bottom">Открыть в системном браузере</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {pendingLogin ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-primary/10 px-3 text-xs">
            <KeyRoundIcon className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              Сохранить логин <span className="font-medium">{pendingLogin.username}</span> для{" "}
              {pendingLogin.origin}?
            </span>
            <button
              type="button"
              onClick={() => void savePendingLogin()}
              className="shrink-0 rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => setPendingLogin(null)}
              className="shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Не сейчас
            </button>
          </div>
        ) : null}
        {deviceToolbarOpen ? (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[11px] text-muted-foreground">
            <MonitorSmartphoneIcon className="size-3.5" />
            <span className="font-mono">
              {viewportSize ? `${viewportSize.width} x ${viewportSize.height}` : "Responsive"}
            </span>
            <button
              type="button"
              onClick={() => setViewportSize(null)}
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              Auto
            </button>
            <button
              type="button"
              onClick={() => setViewportSize({ width: 390, height: 844 })}
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              Mobile
            </button>
            <button
              type="button"
              onClick={() => setViewportSize({ width: 1280, height: 800 })}
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              Desktop
            </button>
            <button
              type="button"
              onClick={() => setDeviceToolbarOpen(false)}
              aria-label="Скрыть device toolbar"
              className="ml-auto inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
        {!isElectron ? (
          <CompanionExtensionPanel url={currentUrl} onOpenExternal={openExternal} />
        ) : mountSrc ? (
          <div
            className={cn(
              "min-h-0 w-full flex-1",
              viewportSize && "overflow-auto bg-muted/20 p-4",
              viewportSize && deviceToolbarOpen && "flex justify-center",
            )}
          >
            <webview
              ref={attachWebview}
              src={mountSrc}
              partition={partition}
              allowpopups
              className={viewportSize ? "shrink-0 bg-background shadow-lg" : "h-full w-full"}
              style={
                viewportSize
                  ? { display: "flex", width: viewportSize.width, height: viewportSize.height }
                  : { display: "flex" }
              }
            />
          </div>
        ) : (
          <NewTabPlaceholder recentUrls={recentUrls} onOpenUrl={navigate} />
        )}
        {loadError ? (
          <div className="absolute inset-x-0 bottom-0 border-t border-border bg-card px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NewTabPlaceholder({
  recentUrls,
  onOpenUrl,
}: {
  recentUrls: readonly string[];
  onOpenUrl: (url: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted-foreground">
      <GlobeIcon className="size-8 opacity-40" />
      <p className="text-xs">Введите адрес в строке выше</p>
      {recentUrls.length > 0 ? (
        <div className="grid w-full max-w-md gap-1.5">
          {recentUrls.slice(0, 6).map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => onOpenUrl(url)}
              className="min-w-0 rounded-md border border-border px-2 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <span className="block truncate">{url}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
