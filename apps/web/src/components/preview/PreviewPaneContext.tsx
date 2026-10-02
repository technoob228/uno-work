import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BrowserLivePage, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import { liveBrowserTabId, liveBrowserTabName } from "./browserLiveStore";
import { browserTabNameForUrl, normalizeBrowserUrl } from "./browserUrl";
import { forgetScrollPosition } from "./previewScrollMemory";
import {
  applyPreviewBucketPatch,
  closeTab,
  collectVisibleTabs,
  DEFAULT_PREVIEW_BUCKET_STATE,
  EMPTY_BROWSER_CONTEXT,
  findTabScopeKey,
  getPreviewBucketState,
  moveTabScope,
  openBrowserTab,
  openTab,
  resolvePanelView,
  setPanelOpen,
  togglePanelOpen,
  updatePanelView,
  type PanelOpenSource,
  type PreviewBucketState,
  type PreviewStates,
} from "./previewPanelState";
import {
  collectPersistableTabs,
  readPersistedTabs,
  readPinnedPanelOpen,
  restoreTabs,
  writePersistedTabs,
  writePinnedPanelOpen,
} from "./previewTabPersistence";
import {
  GLOBAL_SCOPE_KEY,
  projectScopeKey,
  visibleScopeKeys,
  type PreviewTabScope,
  type PreviewTabTarget,
} from "./previewTabScopes";

// Монотонный счётчик id браузерных вкладок: вкладки с одинаковым URL можно
// открыть повторно после закрытия, поэтому id не выводится из URL.
let browserTabCounter = 0;

export type PreviewFileKind =
  | "md"
  | "html"
  | "pdf"
  | "xlsx"
  | "docx"
  | "csv"
  | "json"
  | "image"
  | "svg"
  | "text"
  | "browser"
  | "live-browser"
  | "plugin-panel"
  | "app"
  | "unknown";

export interface PreviewFile {
  id: string;
  name: string;
  kind: PreviewFileKind;
  content: string;
  blobUrl?: string;
  path?: string;
  projectCwd?: string;
  /**
   * Логический проект, из которого вкладку открыли. Уровень вкладки живёт в
   * бакете, а проект нужен отдельно: браузерная вкладка чата/глобального уровня
   * всё равно должна брать cookies-партицию и сохранённые креды своего проекта.
   */
  projectKey?: string;
  environmentId?: EnvironmentId;
  /** Текущий URL для вкладок `kind === "browser"`. Пустая строка = новая вкладка. */
  url?: string;
  /** Страница браузера машины для вкладок `kind === "live-browser"` (browserLive). */
  livePageId?: string;
}

export function isBrowserTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "browser";
}

/**
 * Вкладка браузера самой машины (Work в облаке): картинка страницы с машины и
 * управление по кнопке, а не webview этого устройства — см. LiveBrowserView.
 */
export function isLiveBrowserTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "live-browser";
}

export function makeLiveBrowserFile(input: {
  environmentId: EnvironmentId;
  page: BrowserLivePage;
  projectKey?: string;
}): PreviewFile {
  return {
    id: liveBrowserTabId(input.environmentId, input.page.pageId),
    name: liveBrowserTabName(input.page),
    kind: "live-browser",
    content: "",
    url: input.page.url,
    livePageId: input.page.pageId,
    environmentId: input.environmentId,
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
  };
}

/**
 * Вкладка «браузер ставится»: браузера машины ещё нет (он не в образе Work),
 * страница откроется сама, когда установка закончится.
 */
export function makeBrowserSetupFile(input: {
  environmentId: EnvironmentId;
  projectKey?: string;
}): PreviewFile {
  return {
    id: liveBrowserTabId(input.environmentId, BROWSER_LIVE_SETUP_PAGE_ID),
    name: "Browser",
    kind: "live-browser",
    content: "",
    url: "",
    livePageId: BROWSER_LIVE_SETUP_PAGE_ID,
    environmentId: input.environmentId,
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
  };
}

export function isPluginPanelTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "plugin-panel";
}

/** A web app of the computer (Nextcloud, Vaultwarden…) shown in a frame. */
export function isAppTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "app";
}

/** One tab per app address: opening the same app again focuses its tab. */
export function makeAppFile(input: {
  url: string;
  name: string;
  icon?: string | null;
}): PreviewFile {
  let origin = input.url;
  try {
    origin = new URL(input.url).origin;
  } catch {
    // keep the raw address as the id
  }
  return {
    id: `app:${origin}`,
    name: input.name,
    kind: "app",
    content: input.icon ?? "",
    url: input.url,
  };
}

const PLUGIN_PANEL_ID_PREFIX = "plugin-panel:";

/**
 * Вкладка панельного плагина. URL относительный: панель раздаёт демон текущего
 * окружения (`/api/plugins/<id>/panel/`), а содержимое рендерится в
 * изолированном iframe — см. `PreviewPane`. Это только идентификатор вкладки:
 * iframe грузит подписанный URL с токеном (`pluginPanelUrl.ts`).
 */
export function makePluginPanelFile(pluginId: string, title: string): PreviewFile {
  return {
    id: `${PLUGIN_PANEL_ID_PREFIX}${pluginId}`,
    name: title,
    kind: "plugin-panel",
    content: "",
    url: `/api/plugins/${encodeURIComponent(pluginId)}/panel/`,
  };
}

/** id плагина из вкладки панели — мост должен знать, от чьего имени зовут RPC. */
export function pluginIdFromPanelFile(file: Pick<PreviewFile, "id" | "kind">): string | null {
  if (!isPluginPanelTab(file) || !file.id.startsWith(PLUGIN_PANEL_ID_PREFIX)) return null;
  const pluginId = file.id.slice(PLUGIN_PANEL_ID_PREFIX.length);
  return pluginId.length > 0 ? pluginId : null;
}

export interface BrowserContext {
  environmentId: EnvironmentId | null;
  startPath: string | null;
}

interface PreviewPaneState {
  /** Панель открыта в текущем контексте (чат — свой вид; вне чата — закреплённые вкладки). */
  open: boolean;
  previewLayoutMode: "sidebar" | "focus";
  /** Видимые сейчас вкладки: global → project → chat (вне чата — только global). */
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
  sourceViewFileIds: ReadonlyArray<string>;
  /** Сколько вкладок агент добавил, пока человек держал панель закрытой (бейдж). */
  unseenCount: number;
  /** Ширина панели этого контекста; null — общая по умолчанию. */
  width: number | null;
  setWidth: (width: number) => void;
  toggleSourceView: (id: string) => void;
  currentProjectKey: string;
  currentChatProjectCwd: string | null;
  /** Проект активного чата — вкладки панелей адресуют оркестрацию по нему. */
  currentChatProjectId: ProjectId | null;
  currentChatEnvironmentId: EnvironmentId | null;
  /** Тред открытого чата; null — сейчас на экране не чат (Home, Files, Apps…). */
  currentChatThreadId: string | null;
  /** Уровень каждой видимой вкладки — для значка в ряду вкладок и меню. */
  tabScopeById: Readonly<Record<string, PreviewTabScope>>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
  togglePreviewLayoutMode: () => void;
  /** Открыть файл: в чате — на уровне чата, вне чата — закреплённым везде. */
  openFile: (file: PreviewFile) => void;
  /**
   * Открыть файл во вкладке конкретного треда/проекта (bridge-события
   * харнессов): вкладка попадает в бакет своего уровня и показывается в виде
   * этого треда. `source: "agent"` не распахивает панель, закрытую человеком.
   */
  openFileForTarget: (
    target: PreviewTabTarget,
    scope: PreviewTabScope,
    file: PreviewFile,
    source?: PanelOpenSource,
  ) => void;
  /** Открыть приложение компьютера рядом: в чате — во вкладке чата, вне чата — везде. */
  openAppTab: (file: PreviewFile) => void;
  /**
   * То же, но после перехода в чат `threadId`: вкладка откроется в этом чате,
   * когда он станет текущим.
   */
  queueAppTab: (file: PreviewFile, threadId: string) => void;
  /** Открыть URL в браузерной вкладке (без аргумента — пустая «новая вкладка»). */
  openUrl: (url?: string) => void;
  /** То же для конкретного треда/проекта и уровня — bridge-события харнессов. */
  openUrlForTarget: (
    target: PreviewTabTarget,
    scope: PreviewTabScope,
    url?: string,
    source?: PanelOpenSource,
  ) => void;
  updateBrowserTab: (scopeKey: string, id: string, patch: { url?: string; name?: string }) => void;
  /** Перенести вкладку на другой уровень (чат / проект / везде). */
  setTabScope: (id: string, scope: PreviewTabScope) => void;
  /** Все бакеты предпросмотра — для постоянно смонтированных webview. */
  statesByScopeKey: Readonly<Record<string, PreviewBucketState>>;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  openBrowser: (context: BrowserContext) => void;
  closeBrowser: () => void;
  startEditing: (id: string) => void;
  cancelEditing: () => void;
  applyEditedContent: (id: string, content: string) => void;
  setCurrentChatContext: (context: {
    projectKey: string | null;
    projectCwd: string | null;
    projectId: ProjectId | null;
    environmentId: EnvironmentId | null;
    threadId: string | null;
  }) => void;
  /**
   * Основной чат ушёл с экрана (Home, Files, Apps, Settings…): вид панели
   * переключается на «вне чата». Проект/окружение остаются — файловый браузер
   * и палитра по-прежнему знают, куда загружать.
   */
  leaveChat: (threadId: string) => void;
}

export const NO_PROJECT_KEY = "__no_project__";

/** Формат, у которых есть и rendered-превью, и осмысленный исходник. */
export const DUAL_VIEW_KINDS: ReadonlySet<PreviewFileKind> = new Set<PreviewFileKind>([
  "md",
  "html",
  "svg",
  "csv",
  "json",
]);

export function toggleSourceViewIds(ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

const Ctx = createContext<PreviewPaneState | null>(null);

function initialStates(): Record<string, PreviewBucketState> {
  const restored = restoreTabs(readPersistedTabs());
  const states: Record<string, PreviewBucketState> = {};
  for (const [scopeKey, files] of Object.entries(restored)) {
    if (files.length === 0) continue;
    states[scopeKey] = { ...DEFAULT_PREVIEW_BUCKET_STATE, files };
    // Счётчик id стартует с нуля в каждой сессии, а восстановленные вкладки
    // несут id прошлой — без сдвига новая вкладка получила бы id уже живущей.
    for (const file of files) {
      const suffix = Number.parseInt(file.id.replace("browser-", ""), 10);
      if (Number.isFinite(suffix) && suffix > browserTabCounter) browserTabCounter = suffix;
    }
  }
  // Вне чатов панель показывает только закреплённые вкладки — и только если
  // человек оставил её открытой (флаг v2; старое состояние его не несёт).
  if (readPinnedPanelOpen()) {
    states[GLOBAL_SCOPE_KEY] = {
      ...getPreviewBucketState(states, GLOBAL_SCOPE_KEY),
      open: true,
      viewTouched: true,
    };
  }
  return states;
}

export function PreviewPaneProvider({ children }: { children: ReactNode }) {
  const [statesByScopeKey, setStatesByScopeKey] =
    useState<Record<string, PreviewBucketState>>(initialStates);
  const [currentProjectKey, setCurrentProjectKey] = useState<string>(NO_PROJECT_KEY);
  const [currentChatProjectCwd, setCurrentChatProjectCwd] = useState<string | null>(null);
  const [currentChatProjectId, setCurrentChatProjectId] = useState<ProjectId | null>(null);
  const [currentChatEnvironmentId, setCurrentChatEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [currentChatThreadId, setCurrentChatThreadId] = useState<string | null>(null);

  const currentTarget = useMemo<PreviewTabTarget>(
    () => ({ projectKey: currentProjectKey, threadId: currentChatThreadId }),
    [currentProjectKey, currentChatThreadId],
  );

  // Долгоживущие вкладки (global/project) переживают перезагрузку клиента.
  useEffect(() => {
    writePersistedTabs(collectPersistableTabs(statesByScopeKey));
  }, [statesByScopeKey]);
  const pinnedOpen = getPreviewBucketState(statesByScopeKey, GLOBAL_SCOPE_KEY).open;
  useEffect(() => {
    writePinnedPanelOpen(pinnedOpen);
  }, [pinnedOpen]);

  /** Переход состояний чистой функцией из `previewPanelState`. */
  const transition = useCallback((step: (prev: PreviewStates) => PreviewStates) => {
    setStatesByScopeKey((prev) => {
      const next = step(prev);
      return next === prev ? prev : (next as Record<string, PreviewBucketState>);
    });
  }, []);

  const updateBucket = useCallback(
    (scopeKey: string, updater: (prev: PreviewBucketState) => PreviewBucketState) => {
      setStatesByScopeKey((prev) => {
        const current = getPreviewBucketState(prev, scopeKey);
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [scopeKey]: next };
      });
    },
    [],
  );

  /** Поля вида текущего контекста: у чата — свои, вне чата — глобальные. */
  const updateViewState = useCallback(
    (updater: (prev: PreviewBucketState) => PreviewBucketState) => {
      transition((prev) => updatePanelView(prev, currentTarget, updater));
    },
    [currentTarget, transition],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      transition((prev) => setPanelOpen(prev, currentTarget, open));
    },
    [currentTarget, transition],
  );

  const toggleOpen = useCallback(() => {
    transition((prev) => togglePanelOpen(prev, currentTarget));
  }, [currentTarget, transition]);

  const setPreviewLayoutMode = useCallback(
    (previewLayoutMode: "sidebar" | "focus") => {
      updateViewState((current) =>
        current.previewLayoutMode === previewLayoutMode
          ? current
          : { ...current, previewLayoutMode },
      );
    },
    [updateViewState],
  );

  const togglePreviewLayoutMode = useCallback(() => {
    transition((prev) =>
      updatePanelView(setPanelOpen(prev, currentTarget, true), currentTarget, (current) => ({
        ...current,
        previewLayoutMode: current.previewLayoutMode === "focus" ? "sidebar" : "focus",
      })),
    );
  }, [currentTarget, transition]);

  const setWidth = useCallback(
    (width: number) => {
      updateViewState((current) => (current.width === width ? current : { ...current, width }));
    },
    [updateViewState],
  );

  const openFileForTarget = useCallback(
    (
      target: PreviewTabTarget,
      scope: PreviewTabScope,
      file: PreviewFile,
      source: PanelOpenSource = "person",
    ) => {
      transition((prev) => openTab(prev, target, scope, file, source));
    },
    [transition],
  );

  // Человек открывает что-то сам: в чате — вкладка чата; вне чата смотреть
  // можно только закреплённое, поэтому — «везде».
  const personScope: PreviewTabScope = currentChatThreadId ? "chat" : "global";

  const openFile = useCallback(
    (file: PreviewFile) => {
      openFileForTarget(currentTarget, personScope, file);
    },
    [currentTarget, openFileForTarget, personScope],
  );

  const openAppTab = useCallback(
    (file: PreviewFile) => {
      openFileForTarget(currentTarget, personScope, file);
    },
    [currentTarget, openFileForTarget, personScope],
  );

  const [pendingAppTab, setPendingAppTab] = useState<{
    file: PreviewFile;
    threadId: string;
  } | null>(null);
  const queueAppTab = useCallback((file: PreviewFile, threadId: string) => {
    setPendingAppTab({ file, threadId });
  }, []);
  useEffect(() => {
    if (!pendingAppTab || currentChatThreadId !== pendingAppTab.threadId) return;
    openFileForTarget(currentTarget, "chat", pendingAppTab.file);
    setPendingAppTab(null);
  }, [currentChatThreadId, currentTarget, openFileForTarget, pendingAppTab]);

  const openUrlForTarget = useCallback(
    (
      target: PreviewTabTarget,
      scope: PreviewTabScope,
      url?: string,
      source: PanelOpenSource = "person",
    ) => {
      // Every caller (agents, plugins, links) goes through the address-bar
      // rules: http(s) only — file:, javascript:, chrome:, devtools: never
      // reach a webview. No url = an empty new tab.
      const requested = url?.trim() ?? "";
      const trimmed = requested ? (normalizeBrowserUrl(requested) ?? "") : "";
      if (requested && !/^https?:\/\//i.test(trimmed)) return;
      transition((prev) =>
        openBrowserTab(
          prev,
          target,
          scope,
          trimmed,
          () => ({
            id: `browser-${++browserTabCounter}`,
            name: trimmed ? browserTabNameForUrl(trimmed) : "New tab",
            kind: "browser",
            content: "",
            url: trimmed,
            projectKey: target.projectKey,
          }),
          source,
        ),
      );
    },
    [transition],
  );

  const openUrl = useCallback(
    (url?: string) => {
      openUrlForTarget(currentTarget, personScope, url);
    },
    [currentTarget, openUrlForTarget, personScope],
  );

  const updateBrowserTab = useCallback(
    (scopeKey: string, id: string, patch: { url?: string; name?: string }) => {
      updateBucket(scopeKey, (current) => {
        const idx = current.files.findIndex(
          (f) => f.id === id && (isBrowserTab(f) || isLiveBrowserTab(f)),
        );
        if (idx === -1) return current;
        const existing = current.files[idx]!;
        const updated: PreviewFile = {
          ...existing,
          ...(patch.url !== undefined ? { url: patch.url } : {}),
          ...(patch.name !== undefined && patch.name.length > 0 ? { name: patch.name } : {}),
        };
        if (updated.url === existing.url && updated.name === existing.name) return current;
        return {
          ...current,
          files: [...current.files.slice(0, idx), updated, ...current.files.slice(idx + 1)],
        };
      });
    },
    [updateBucket],
  );

  const setTabScope = useCallback(
    (id: string, scope: PreviewTabScope) => {
      transition((prev) => moveTabScope(prev, currentTarget, id, scope));
    },
    [currentTarget, transition],
  );

  const closeFile = useCallback(
    (id: string) => {
      transition((prev) => {
        const result = closeTab(prev, currentTarget, id);
        if (result.closed?.blobUrl) URL.revokeObjectURL(result.closed.blobUrl);
        return result.states;
      });
      forgetScrollPosition(id);
    },
    [currentTarget, transition],
  );

  const toggleSourceView = useCallback(
    (id: string) => {
      updateViewState((current) => ({
        ...current,
        sourceViewFileIds: toggleSourceViewIds(current.sourceViewFileIds, id),
      }));
    },
    [updateViewState],
  );

  const startEditing = useCallback(
    (id: string) => {
      updateViewState((current) =>
        current.editingFileId === id ? current : { ...current, editingFileId: id },
      );
    },
    [updateViewState],
  );

  const cancelEditing = useCallback(() => {
    updateViewState((current) =>
      current.editingFileId === null ? current : { ...current, editingFileId: null },
    );
  }, [updateViewState]);

  const applyEditedContent = useCallback(
    (id: string, content: string) => {
      setStatesByScopeKey((prev) => {
        const scopeKey = findTabScopeKey(prev, id, visibleScopeKeys(currentTarget));
        if (!scopeKey) return prev;
        const bucket = getPreviewBucketState(prev, scopeKey);
        const idx = bucket.files.findIndex((f) => f.id === id);
        if (idx === -1) return prev;
        const updated = { ...bucket.files[idx]!, content };
        const next = {
          ...prev,
          [scopeKey]: {
            ...bucket,
            files: [...bucket.files.slice(0, idx), updated, ...bucket.files.slice(idx + 1)],
          },
        };
        return updatePanelView(next, currentTarget, (view) => ({
          ...view,
          editingFileId: null,
        })) as Record<string, PreviewBucketState>;
      });
    },
    [currentTarget],
  );

  const setActiveFile = useCallback(
    (id: string) => {
      updateViewState((current) =>
        current.activeFileId === id ? current : { ...current, activeFileId: id },
      );
    },
    [updateViewState],
  );

  const openBrowser = useCallback(
    (context: BrowserContext) => {
      updateViewState((current) => ({
        ...current,
        browserOpen: true,
        browserContext: context,
      }));
    },
    [updateViewState],
  );

  const closeBrowser = useCallback(() => {
    updateViewState((current) =>
      current.browserOpen ? { ...current, browserOpen: false } : current,
    );
  }, [updateViewState]);

  const setCurrentChatContext = useCallback(
    (context: {
      projectKey: string | null;
      projectCwd: string | null;
      projectId: ProjectId | null;
      environmentId: EnvironmentId | null;
      threadId: string | null;
    }) => {
      setCurrentProjectKey(context.projectKey ?? NO_PROJECT_KEY);
      setCurrentChatProjectCwd(context.projectCwd);
      setCurrentChatProjectId(context.projectId);
      setCurrentChatEnvironmentId(context.environmentId);
      setCurrentChatThreadId(context.threadId);
    },
    [],
  );

  const leaveChat = useCallback((threadId: string) => {
    // Только если ушёл именно этот чат: при переходе чат → чат новый уже
    // успел записать себя.
    setCurrentChatThreadId((current) => (current === threadId ? null : current));
  }, []);

  const {
    view: viewState,
    open,
    files,
    tabScopeById,
  } = useMemo(
    () => resolvePanelView(statesByScopeKey, currentTarget),
    [statesByScopeKey, currentTarget],
  );

  const value = useMemo<PreviewPaneState>(
    () => ({
      open,
      previewLayoutMode: viewState.previewLayoutMode,
      files,
      activeFileId: viewState.activeFileId,
      browserOpen: viewState.browserOpen,
      browserContext: viewState.browserContext,
      editingFileId: viewState.editingFileId,
      sourceViewFileIds: viewState.sourceViewFileIds,
      unseenCount: open ? 0 : viewState.unseen,
      width: viewState.width,
      setWidth,
      toggleSourceView,
      currentProjectKey,
      currentChatProjectCwd,
      currentChatProjectId,
      currentChatEnvironmentId,
      currentChatThreadId,
      tabScopeById,
      setOpen,
      toggleOpen,
      setPreviewLayoutMode,
      togglePreviewLayoutMode,
      openFile,
      openFileForTarget,
      openAppTab,
      queueAppTab,
      openUrl,
      openUrlForTarget,
      updateBrowserTab,
      setTabScope,
      statesByScopeKey,
      closeFile,
      setActiveFile,
      openBrowser,
      closeBrowser,
      startEditing,
      cancelEditing,
      applyEditedContent,
      setCurrentChatContext,
      leaveChat,
    }),
    [
      open,
      viewState,
      files,
      tabScopeById,
      currentProjectKey,
      currentChatProjectCwd,
      currentChatProjectId,
      currentChatEnvironmentId,
      currentChatThreadId,
      setWidth,
      toggleSourceView,
      setOpen,
      toggleOpen,
      setPreviewLayoutMode,
      togglePreviewLayoutMode,
      openFile,
      openFileForTarget,
      openAppTab,
      queueAppTab,
      openUrl,
      openUrlForTarget,
      updateBrowserTab,
      setTabScope,
      statesByScopeKey,
      closeFile,
      setActiveFile,
      openBrowser,
      closeBrowser,
      startEditing,
      cancelEditing,
      applyEditedContent,
      setCurrentChatContext,
      leaveChat,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreviewPane(): PreviewPaneState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePreviewPane must be used within PreviewPaneProvider");
  return ctx;
}

export interface ChatPanelContext {
  readonly projectKey: string | null;
  readonly projectCwd: string | null;
  readonly projectId: ProjectId | null;
  readonly environmentId: EnvironmentId | null;
  /** Тред чата: по нему адресуются вкладки и вид панели этого чата. */
  readonly threadId: string | null;
}

/**
 * Основной чат на экране сообщает панели свой контекст, а уходя (Home, Files,
 * Apps, Settings, другой чат) — забирает свой вид с собой: вне чата видны
 * только закреплённые везде вкладки. null — не основной чат (встроенный в
 * панель экземпляр), ничего не проставляем.
 */
export function useChatPanelContext(context: ChatPanelContext | null): void {
  const { setCurrentChatContext, leaveChat } = usePreviewPane();
  const active = context !== null;
  const projectKey = context?.projectKey ?? null;
  const projectCwd = context?.projectCwd ?? null;
  const projectId = context?.projectId ?? null;
  const environmentId = context?.environmentId ?? null;
  const threadId = context?.threadId ?? null;
  useEffect(() => {
    if (!active) return;
    setCurrentChatContext({ projectKey, projectCwd, projectId, environmentId, threadId });
    return () => {
      if (threadId) leaveChat(threadId);
    };
  }, [
    active,
    environmentId,
    leaveChat,
    projectCwd,
    projectId,
    projectKey,
    setCurrentChatContext,
    threadId,
  ]);
}

export { GLOBAL_SCOPE_KEY, projectScopeKey };
export type { PreviewTabScope, PreviewTabTarget };
export {
  applyPreviewBucketPatch,
  collectVisibleTabs,
  DEFAULT_PREVIEW_BUCKET_STATE,
  EMPTY_BROWSER_CONTEXT,
  findTabScopeKey,
  getPreviewBucketState,
};
export type { PanelOpenSource, PreviewBucketState };

const TEXT_EXTS = new Set([
  "txt",
  "log",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "css",
  "scss",
  "less",
  "js",
  "cjs",
  "mjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "vue",
  "svelte",
]);

export function detectFileKind(name: string): PreviewFileKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (ext === "xlsx" || ext === "xls") return "xlsx";
  if (ext === "docx") return "docx";
  if (ext === "svg") return "svg";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
    return "image";
  }
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}
