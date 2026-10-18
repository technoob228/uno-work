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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

import { useDemoDesktop } from "../../demo/demoFlag";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import {
  isBrowserExtensionConnected,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { cn } from "../../lib/utils";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { useSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  clearBrowserAutomationHandler,
  clearBrowserTabAutomationHandler,
  setBrowserAutomationHandler,
  setBrowserTabAutomationHandler,
} from "./BrowserAutomationRegistry";
import { CommentBar, CommentLayer } from "./annotate/CommentLayer";
import { DebugDrawer } from "./annotate/DebugDrawer";
import { IframeWebview } from "./annotate/iframeWebview";
import { base64ToBlob } from "./annotate/liveWebview";
import { PageToolsButtons } from "./annotate/PageToolsButtons";
import { usePageToolsStore, usePageToolsTab } from "./annotate/pageToolsStore";
import { usePageTools } from "./annotate/usePageTools";
import { CompanionExtensionPanel } from "./CompanionExtensionPanel";
import { YourBrowserTab } from "./YourBrowserTab";
import { browserTabMode } from "./yourBrowserTab.logic";
import { WEB_PAGE_IN_PANEL } from "./browserSource";
import { DEVICE_ZOOM_CHOICES, deviceScaleFor, type DeviceZoom } from "./deviceZoom";

/** The page at its real size, its picture scaled from the top left corner. */
function deviceFrameStyle(
  size: { readonly width: number; readonly height: number },
  scale: number,
): React.CSSProperties {
  return {
    width: size.width,
    height: size.height,
    ...(scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: "0 0" }),
  };
}

/** A page of the address Work itself is served from (the web's iframe can reach only those). */
function isSameOriginUrl(url: string): boolean {
  if (!url) return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
import { isTypingTarget } from "./panelLauncher.logic";
import { useChatBrowser } from "./useChatBrowser";
import { BrowserSourceChip } from "./BrowserSourceChip";
import {
  browserPartitionForScope,
  browserUrlOrigin,
  isComputerLocalUrl,
  normalizeBrowserUrl,
} from "./browserUrl";
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
  capturePage?: (rect?: { x: number; y: number; width: number; height: number }) => Promise<{
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
  // The web version shows a tab's page from the computer's browser (p.14);
  // the desktop app (and its demo) keeps its own page in the panel.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const demoDesktop = useDemoDesktop();
  const mode = browserTabMode({
    desktopApp: isElectron || demoDesktop || WEB_PAGE_IN_PANEL,
    computer: primaryEnvironmentId !== null,
  });
  const visibleKeys = new Set(
    visibleScopeKeys({ projectKey: currentProjectKey, threadId: currentChatThreadId }),
  );
  const views: ReactNode[] = [];
  for (const [scopeKey, bucket] of Object.entries(statesByScopeKey)) {
    const tabs = bucket.files.filter(isBrowserTab);
    if (tabs.length === 0) continue;
    // Таргет автоматизации бакета: активная браузерная вкладка, иначе
    // последняя открытая — команды работают, даже когда активен файл-превью.
    // У чата вид свой (и для чата не на экране тоже), у общих уровней — вид
    // того, что сейчас на экране.
    const bucketActiveId = scopeOfKey(scopeKey) === "chat" ? bucket.activeFileId : activeFileId;
    const automationTabId =
      bucketActiveId && tabs.some((tab) => tab.id === bucketActiveId)
        ? bucketActiveId
        : tabs[tabs.length - 1]!.id;
    for (const tab of tabs) {
      const visible = visibleKeys.has(scopeKey) && tab.id === activeId;
      if (mode === "computer" && primaryEnvironmentId) {
        views.push(
          <YourBrowserTab
            key={`${scopeKey}::${tab.id}`}
            tab={tab}
            scopeKey={scopeKey}
            environmentId={primaryEnvironmentId}
            visible={visible}
          />,
        );
        continue;
      }
      views.push(
        <BrowserView
          // Один и тот же файл может быть открыт в бакетах разных тредов —
          // ключ обязан включать бакет, иначе React увидит дубль.
          key={`${scopeKey}::${tab.id}`}
          tab={tab}
          scopeKey={scopeKey}
          projectKey={browserTabProjectKey(tab, scopeKey)}
          visible={visible}
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
  const { updateBrowserTab, currentChatThreadId, currentChatProjectCwd, closeFile } =
    usePreviewPane();
  const browserProfileScope = useSettings((settings) => settings.browserProfileScope);
  // The page lives in the panel: the desktop app's <webview>, or — in the demo
  // of the desktop app — a same-origin iframe that talks like one.
  const demoDesktop = useDemoDesktop();
  const pageInPanel = isElectron || demoDesktop || WEB_PAGE_IN_PANEL;
  const iframeMode = !isElectron;
  // Comment / Debug (flag `browserPageTools`): only where the page is in the
  // panel (the desktop app, its demo). The web build's page is a companion
  // tab in the person's own browser — no tools there, flag or not.
  const pageToolsFlag = useFeatureFlag("browserPageTools");
  const currentUrl = tab.url ?? "";
  // The web's iframe reaches only a page of Work's own address; on any other
  // page Comment couldn't see it, so it isn't offered there.
  const pageToolsOn =
    pageToolsFlag && pageInPanel && (!iframeMode || demoDesktop || isSameOriginUrl(currentUrl));
  const pageElementRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
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
  // A device size bigger than the panel renders at its real size and the
  // picture shrinks to fit, like DevTools' device mode (Misha 18.10).
  const [deviceZoom, setDeviceZoom] = useState<DeviceZoom>("fit");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !viewportSize) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewportSize]);
  const deviceScale = viewportSize ? deviceScaleFor(viewportSize, stage, deviceZoom) : 1;
  const [recentUrls, setRecentUrls] = useState<readonly string[]>(() => readBrowserRecents());
  const credentialsQuery = useVaultCredentials();
  const invalidateCredentials = useInvalidateBrowserCredentials();
  // Перехваченный логин, который ещё не сохранён: плашка «Сохранить?» над страницей.
  const [pendingLogin, setPendingLogin] = useState<{
    origin: string;
    username: string;
    password: string;
  } | null>(null);

  // No "Opens in" chip (Misha 16.10, Labs `panelLauncherV2`): Your site and
  // the agent's browser are two tools, not one browser with a default. Moving
  // a page over is an explicit action in ⋮, for when the agent should work
  // with it there. Without the flag — the chip of 0.0.137.
  const launcherV2 = useFeatureFlag("panelLauncherV2");
  const { sources: browserSources, openInSource } = useChatBrowser();
  const canOpenInAgentBrowser = browserSources.includes("computer");
  // The web version (Misha 16.10 p.12): the site being built on a cloud
  // computer is the computer's own localhost — this device's browser would
  // open its own. Such a page opens in the computer's browser, in the panel,
  // with Comment; public addresses stay as they are (a tab of this browser).
  const openedOnComputerRef = useRef<string | null>(null);
  useEffect(() => {
    // Still in the web (Misha 17.10): until Work forwards the computer's ports
    // to its own address, this device's iframe would open its own localhost.
    if (isElectron || demoDesktop || !visible || !pageToolsFlag || !canOpenInAgentBrowser) return;
    if (!currentUrl || !isComputerLocalUrl(currentUrl)) return;
    if (openedOnComputerRef.current === currentUrl) return;
    openedOnComputerRef.current = currentUrl;
    openInSource("computer", currentUrl);
    closeFile(tab.id);
  }, [
    demoDesktop,
    visible,
    pageToolsFlag,
    canOpenInAgentBrowser,
    currentUrl,
    openInSource,
    closeFile,
    tab.id,
  ]);
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
      if (!pageInPanel) {
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
    [scopeKey, tab.id, updateBrowserTab, pageInPanel],
  );

  const attachWebview = useCallback((node: HTMLWebViewElement | null) => {
    const view = node as ElectronWebviewElement | null;
    webviewRef.current = view;
    pageElementRef.current = node;
    if (!view) readyRef.current = false;
    setWebviewNode(view);
  }, []);

  // The demo's iframe, wrapped so everything above treats it as a <webview>.
  const iframeAdapterRef = useRef<IframeWebview | null>(null);
  const attachIframe = useCallback((node: HTMLIFrameElement | null) => {
    iframeAdapterRef.current?.dispose();
    iframeAdapterRef.current = node ? new IframeWebview(node) : null;
    const view = iframeAdapterRef.current as unknown as ElectronWebviewElement | null;
    webviewRef.current = view;
    pageElementRef.current = node;
    if (!view) readyRef.current = false;
    setWebviewNode(view);
  }, []);

  // Comment mode (C): the page's half lives in the page. The picked element's
  // picture goes with the comment (the desktop's <webview>; the demo's iframe has none).
  const capturePick = useCallback(
    async (rect: { x: number; y: number; w: number; h: number }): Promise<Blob | null> => {
      const view = webviewRef.current;
      if (iframeMode || !view?.capturePage) return null;
      const bounds = view.getBoundingClientRect();
      const zoom = zoomFactor;
      const x = Math.max(0, Math.floor(rect.x * zoom));
      const y = Math.max(0, Math.floor(rect.y * zoom));
      const width = Math.min(Math.ceil(rect.w * zoom), Math.floor(bounds.width) - x);
      const height = Math.min(Math.ceil(rect.h * zoom), Math.floor(bounds.height) - y);
      if (width < 1 || height < 1) return null;
      const image = await view.capturePage({ x, y, width, height });
      const dataUrl = image.toDataURL();
      if (image.isEmpty?.() === true || isEmptyScreenshot(dataUrl)) return null;
      const comma = dataUrl.indexOf(",");
      return comma < 0 ? null : base64ToBlob(dataUrl.slice(comma + 1), "image/png");
    },
    [iframeMode, zoomFactor],
  );
  usePageTools({
    tabId: tab.id,
    view: webviewNode,
    enabled: pageToolsOn,
    capture: capturePick,
  });
  const pageTools = usePageToolsTab(tab.id);
  useEffect(() => {
    if (!visible || !pageToolsOn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || !rootRef.current?.contains(target) || isTypingTarget(target)) return;
      const store = usePageToolsStore.getState();
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "c") store.toggleMode(tab.id);
      else if (key !== "Escape" || !store.escape(tab.id)) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, pageToolsOn, tab.id]);

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
      setLoadError(
        `${failEvent.errorDescription || "Page failed to load"} (${failEvent.errorCode})`,
      );
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
            title: "Couldn't fill in the login",
            description: result.error ?? "Open the sign-in form on the page and try again.",
            type: "warning",
          });
        }
      } catch (error) {
        toastManager.add({
          title: "Saved logins are unavailable",
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
        title: existing ? `Password for ${host} updated` : `Login for ${host} saved`,
        description: "Use the key button in the address bar to fill it in.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save the login",
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
        title: "Screenshot unavailable",
        description: "The page didn't return an image.",
      });
      return null;
    }
    await navigator.clipboard?.writeText(dataUrl).catch(() => undefined);
    toastManager.add({
      type: "success",
      title: "Screenshot ready",
      description: "Copied to the clipboard as a data URL.",
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
            ? "Cache cleared"
            : kind === "cookies"
              ? "Cookies cleared"
              : "Data cleared",
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
          if (filled !== true) throw new Error("No login fields found on the page.");
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
      ref={rootRef}
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
            aria-label="Back"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => webviewRef.current?.goForward()}
            disabled={!canGoForward}
            aria-label="Forward"
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
            aria-label={loading ? "Stop" : "Reload"}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <XIcon className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
          </button>
          {launcherV2 ? null : <BrowserSourceChip source="app" tabId={tab.id} url={currentUrl} />}
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
              placeholder="Enter an address or search"
              autoFocus={!mountSrc}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className={cn(
                "h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-foreground outline-none placeholder:text-muted-foreground focus:border-ring",
                pageToolsOn ? "text-xs" : "font-mono text-[11px]",
              )}
            />
          </form>
          {loading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          {pageToolsOn ? (
            <PageToolsButtons tabId={tab.id} disabled={!mountSrc} />
          ) : (
            <>
              <button
                type="button"
                onClick={() => applyZoom(zoomFactor - ZOOM_STEP)}
                disabled={!mountSrc}
                aria-label="Zoom out"
                title="Zoom out"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <MinusIcon className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => applyZoom(DEFAULT_ZOOM_FACTOR)}
                disabled={!mountSrc}
                aria-label="Reset zoom"
                title="Reset zoom"
                className="inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {Math.round(zoomFactor * 100)}%
              </button>
              <button
                type="button"
                onClick={() => applyZoom(zoomFactor + ZOOM_STEP)}
                disabled={!mountSrc}
                aria-label="Zoom in"
                title="Zoom in"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={async (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const choice = await readLocalApi()?.contextMenu.show(
                [
                  ...(launcherV2 && canOpenInAgentBrowser
                    ? [{ id: "agent-browser", label: "Open in agent's browser" }]
                    : []),
                  // With Comment in the bar, zoom moves in here.
                  ...(pageToolsOn
                    ? [
                        { id: "zoom-in", label: "Zoom in" },
                        { id: "zoom-out", label: "Zoom out" },
                        {
                          id: "zoom-reset",
                          label: `Actual size (now ${Math.round(zoomFactor * 100)}%)`,
                        },
                      ]
                    : []),
                  { id: "force-reload", label: "Reload without cache" },
                  { id: "screenshot", label: "Take a screenshot" },
                  { id: "responsive", label: "Responsive" },
                  { id: "mobile", label: "Mobile 390x844" },
                  { id: "tablet", label: "Tablet 768x1024" },
                  { id: "desktop", label: "Desktop 1280x800" },
                  { id: "cache", label: "Clear cache" },
                  { id: "cookies", label: "Clear cookies for this site" },
                  { id: "all", label: "Clear cookies and cache" },
                ],
                { x: rect.left, y: rect.bottom + 4 },
              );
              if (choice === "agent-browser") openInSource("computer", currentUrl);
              else if (choice === "zoom-in") applyZoom(zoomFactor + ZOOM_STEP);
              else if (choice === "zoom-out") applyZoom(zoomFactor - ZOOM_STEP);
              else if (choice === "zoom-reset") applyZoom(DEFAULT_ZOOM_FACTOR);
              else if (choice === "force-reload") {
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
            aria-label="More actions"
            title="More actions"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MoreVerticalIcon className="size-3.5" />
          </button>
          {/* Кнопка есть в обеих оболочках: пароль подставляет сервер, поэтому
              заполнение работает и в браузерной версии (через companion), и в
              десктопе, и в headless-браузере бокса. */}
          {/* With Comment / Debug in the bar, the key shows only when it has a login. */}
          {!pageToolsOn || matchedCredentials.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={handleAutofillClick}
                    disabled={matchedCredentials.length === 0}
                    aria-label={
                      matchedCredentials.length > 0
                        ? "Fill in saved login"
                        : "No saved logins for this site"
                    }
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <KeyRoundIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="bottom">
                {matchedCredentials.length > 0
                  ? "Fill in login and password"
                  : origin
                    ? `No saved logins for ${origin}`
                    : "Open a site to find a saved login"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={openExternal}
                  disabled={!currentUrl}
                  aria-label="Open in your browser"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="bottom">Open in your browser</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {pendingLogin ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-primary/10 px-3 text-xs">
            <KeyRoundIcon className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              Save login <span className="font-medium">{pendingLogin.username}</span> for{" "}
              {pendingLogin.origin}?
            </span>
            <button
              type="button"
              onClick={() => void savePendingLogin()}
              className="shrink-0 rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setPendingLogin(null)}
              className="shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Not now
            </button>
          </div>
        ) : null}
        {deviceToolbarOpen ? (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[11px] text-muted-foreground">
            <MonitorSmartphoneIcon className="size-3.5" />
            <span className="font-mono" data-testid="device-size-label">
              {viewportSize
                ? `${viewportSize.width} × ${viewportSize.height} · ${Math.round(deviceScale * 100)}%`
                : "Responsive"}
            </span>
            {viewportSize ? (
              <select
                aria-label="Zoom"
                value={String(deviceZoom)}
                onChange={(event) =>
                  setDeviceZoom(event.target.value === "fit" ? "fit" : Number(event.target.value))
                }
                className="h-5 rounded border border-border bg-transparent px-1 text-[11px] text-foreground"
              >
                {DEVICE_ZOOM_CHOICES.map((choice) => (
                  <option key={String(choice)} value={String(choice)}>
                    {choice === "fit" ? "Fit" : `${Math.round(choice * 100)}%`}
                  </option>
                ))}
              </select>
            ) : null}
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
              onClick={() => setViewportSize({ width: 768, height: 1024 })}
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            >
              Tablet
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
              aria-label="Hide device toolbar"
              className="ml-auto inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
        {!pageInPanel ? (
          <CompanionExtensionPanel url={currentUrl} onOpenExternal={openExternal} />
        ) : mountSrc ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={stageRef}
              className={cn(
                "min-h-0 w-full flex-1",
                viewportSize && "overflow-auto bg-muted/20 p-4",
                viewportSize && deviceToolbarOpen && "flex items-start justify-center",
              )}
            >
              <div
                className={viewportSize ? "relative shrink-0 shadow-lg" : "contents"}
                style={
                  viewportSize
                    ? {
                        width: Math.round(viewportSize.width * deviceScale),
                        height: Math.round(viewportSize.height * deviceScale),
                      }
                    : undefined
                }
              >
                {iframeMode ? (
                  <iframe
                    ref={attachIframe}
                    src={mountSrc}
                    // Same origin on purpose (Comment / Debug reach the page);
                    // no top navigation, so a page can't take Work away.
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    title={tab.name || "Browser"}
                    className={cn(
                      "border-0 bg-white",
                      viewportSize ? "absolute top-0 left-0 block" : "block h-full w-full",
                    )}
                    style={viewportSize ? deviceFrameStyle(viewportSize, deviceScale) : undefined}
                  />
                ) : (
                  <webview
                    ref={attachWebview}
                    src={mountSrc}
                    partition={partition}
                    allowpopups
                    className={
                      viewportSize ? "absolute top-0 left-0 bg-background" : "h-full w-full"
                    }
                    style={
                      viewportSize
                        ? { display: "flex", ...deviceFrameStyle(viewportSize, deviceScale) }
                        : { display: "flex" }
                    }
                  />
                )}
              </div>
            </div>
            {pageToolsOn ? (
              <CommentLayer
                tabId={tab.id}
                pageRef={pageElementRef}
                zoom={(iframeMode ? 1 : zoomFactor) * deviceScale}
              />
            ) : null}
          </div>
        ) : (
          <NewTabPlaceholder recentUrls={recentUrls} onOpenUrl={navigate} />
        )}
        {pageToolsOn && mountSrc ? <CommentBar tabId={tab.id} pageUrl={currentUrl} /> : null}
        {/* Comment mode shows the page's console and network below (one mode). */}
        {pageToolsOn && mountSrc && pageTools.commenting ? (
          <DebugDrawer tabId={tab.id} pageUrl={currentUrl} />
        ) : null}
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
      <p className="text-xs">Enter an address above</p>
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
