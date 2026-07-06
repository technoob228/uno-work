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
import type { BrowserAutomationCommandInput, BrowserCredentialRecord } from "@t3tools/contracts";
import {
  buildClickSelectorScript,
  buildClickTextScript,
  buildTypeScript,
} from "@t3tools/shared/browserAutomationScripts";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  clearBrowserAutomationHandler,
  setBrowserAutomationHandler,
} from "./BrowserAutomationRegistry";
import { buildAutofillScript } from "./browserAutofill";
import { browserPartitionForScope, browserUrlOrigin, normalizeBrowserUrl } from "./browserUrl";
import { isBrowserTab, usePreviewPane, type PreviewFile } from "./PreviewPaneContext";

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
  capturePage?: () => Promise<{ toDataURL: () => string }>;
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

interface WebviewFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

const BROWSER_CREDENTIALS_QUERY_KEY = ["browserCredentials"] as const;
const BROWSER_RECENTS_STORAGE_KEY = "uno_browser_recent_urls";
const MAX_BROWSER_RECENTS = 8;
const DEFAULT_ZOOM_FACTOR = 1;
const ZOOM_STEP = 0.1;

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

export function useBrowserCredentials() {
  return useQuery({
    queryKey: BROWSER_CREDENTIALS_QUERY_KEY,
    queryFn: async (): Promise<readonly BrowserCredentialRecord[]> => {
      if (!window.desktopBridge) return [];
      return window.desktopBridge.listBrowserCredentials();
    },
    enabled: isElectron,
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

function matchCredentialsForOrigin(input: {
  credentials: readonly BrowserCredentialRecord[] | undefined;
  origin: string | null;
  projectKey: string;
}): readonly BrowserCredentialRecord[] {
  if (!input.credentials || !input.origin) return [];
  return input.credentials.filter(
    (credential) =>
      credential.origin === input.origin &&
      (credential.scope === "account" || credential.projectKey === input.projectKey),
  );
}

/**
 * Все браузерные вкладки держатся смонтированными (скрытые — `visibility`),
 * чтобы webview не терял состояние страницы при переключении вкладок.
 * Вкладки чужих (не активных сейчас) проектов тоже остаются жить: команды
 * харнесса из другого проекта исполняются в их webview, а не в текущем.
 */
export function BrowserViews({ activeId }: { activeId: string | null }) {
  const { statesByProjectKey, currentProjectKey } = usePreviewPane();
  const views: ReactNode[] = [];
  for (const [projectKey, bucket] of Object.entries(statesByProjectKey)) {
    const tabs = bucket.files.filter(isBrowserTab);
    if (tabs.length === 0) continue;
    // Таргет автоматизации проекта: его активная браузерная вкладка, иначе
    // последняя открытая — команды работают, даже когда активен файл-превью.
    const automationTabId =
      bucket.activeFileId && tabs.some((tab) => tab.id === bucket.activeFileId)
        ? bucket.activeFileId
        : tabs[tabs.length - 1]!.id;
    for (const tab of tabs) {
      views.push(
        <BrowserView
          key={tab.id}
          tab={tab}
          projectKey={projectKey}
          visible={projectKey === currentProjectKey && tab.id === activeId}
          automationActive={tab.id === automationTabId}
        />,
      );
    }
  }
  if (views.length === 0) return null;
  return <>{views}</>;
}

function BrowserView({
  tab,
  projectKey,
  visible,
  automationActive,
}: {
  tab: PreviewFile;
  projectKey: string;
  visible: boolean;
  automationActive: boolean;
}) {
  const { updateBrowserTab } = usePreviewPane();
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
  const credentialsQuery = useBrowserCredentials();

  const currentUrl = tab.url ?? "";
  const origin = browserUrlOrigin(currentUrl);
  const matchedCredentials = useMemo(
    () =>
      matchCredentialsForOrigin({
        credentials: credentialsQuery.data,
        origin,
        projectKey,
      }),
    [credentialsQuery.data, origin, projectKey],
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
      updateBrowserTab(projectKey, tab.id, { url });
      const view = webviewRef.current;
      if (view && readyRef.current) {
        void view.loadURL(url).catch(() => {});
      } else {
        setMountSrc(url);
      }
    },
    [projectKey, tab.id, updateBrowserTab],
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
    };
    const onStartLoading = () => setLoading(true);
    const onStopLoading = () => setLoading(false);
    const onNavigate = (event: Event) => {
      const navigateEvent = event as WebviewNavigateEvent;
      if (navigateEvent.isMainFrame === false) return;
      setLoadError(null);
      updateBrowserTab(projectKey, tab.id, { url: navigateEvent.url });
      syncNavState();
    };
    const onTitleUpdated = (event: Event) => {
      const titleEvent = event as WebviewTitleEvent;
      updateBrowserTab(projectKey, tab.id, { name: titleEvent.title });
    };
    const onFailLoad = (event: Event) => {
      const failEvent = event as WebviewFailLoadEvent;
      // -3 (ERR_ABORTED) приходит при штатной отмене навигации.
      if (!failEvent.isMainFrame || failEvent.errorCode === -3) return;
      setLoadError(`${failEvent.errorDescription || "Ошибка загрузки"} (${failEvent.errorCode})`);
    };

    view.addEventListener("dom-ready", onDomReady);
    view.addEventListener("did-start-loading", onStartLoading);
    view.addEventListener("did-stop-loading", onStopLoading);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitleUpdated);
    view.addEventListener("did-fail-load", onFailLoad);
    return () => {
      view.removeEventListener("dom-ready", onDomReady);
      view.removeEventListener("did-start-loading", onStartLoading);
      view.removeEventListener("did-stop-loading", onStopLoading);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitleUpdated);
      view.removeEventListener("did-fail-load", onFailLoad);
    };
  }, [webviewNode, projectKey, tab.id, updateBrowserTab]);

  const autofillCredential = useCallback(async (credential: BrowserCredentialRecord) => {
    const view = webviewRef.current;
    if (!view || !window.desktopBridge) return;
    const password = await window.desktopBridge.revealBrowserCredentialPassword(credential.id);
    if (password === null) {
      toastManager.add({
        title: "Не удалось расшифровать пароль",
        description: "Проверьте сохранённые креды в настройках браузера.",
        type: "error",
      });
      return;
    }
    const filled = await view
      .executeJavaScript(buildAutofillScript(credential.username, password), true)
      .catch(() => false);
    if (!filled) {
      toastManager.add({
        title: "Поля логина не найдены",
        description: "Откройте форму входа на странице и попробуйте ещё раз.",
        type: "warning",
      });
    }
  }, []);

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
    const dataUrl = await webviewRef.current?.capturePage?.().then((image) => image.toDataURL());
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
        case "screenshot": {
          const dataUrl = await view.capturePage?.().then((image) => image.toDataURL());
          if (!dataUrl) throw new Error("capturePage is unavailable.");
          return { dataUrl };
        }
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
      }
    },
    [currentUrl, loading, navigate, tab.name],
  );

  useEffect(() => {
    if (!automationActive) return;
    setBrowserAutomationHandler(projectKey, handleAutomationCommand);
    return () => {
      clearBrowserAutomationHandler(projectKey, handleAutomationCommand);
    };
  }, [automationActive, handleAutomationCommand, projectKey]);

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
          {isElectron ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={handleAutofillClick}
                    disabled={matchedCredentials.length === 0}
                    aria-label={
                      matchedCredentials.length > 0
                        ? "Заполнить сохранённые креды"
                        : "Нет сохранённых кредов для текущего сайта"
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
                    ? `Нет сохранённых кредов для ${origin}`
                    : "Откройте сайт, чтобы подобрать сохранённые креды"}
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
          <BrowserUnavailableFallback url={currentUrl} onOpenExternal={openExternal} />
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

function BrowserUnavailableFallback({
  url,
  onOpenExternal,
}: {
  url: string;
  onOpenExternal: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <GlobeIcon className="size-8 opacity-40" />
      <p className="text-xs">Встроенный браузер доступен только в десктоп-приложении.</p>
      {url ? (
        <button
          type="button"
          onClick={onOpenExternal}
          className="rounded-md border border-input px-3 py-1.5 text-xs hover:bg-accent hover:text-foreground"
        >
          Открыть в системном браузере
        </button>
      ) : null}
    </div>
  );
}
