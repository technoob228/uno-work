import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { browserTabNameForUrl } from "./browserUrl";
import { forgetScrollPosition } from "./previewScrollMemory";
import {
  collectPersistableTabs,
  readPersistedTabs,
  restoreTabs,
  writePersistedTabs,
} from "./previewTabPersistence";
import {
  GLOBAL_SCOPE_KEY,
  projectScopeKey,
  scopeKeyForTarget,
  scopeOfKey,
  viewScopeKey,
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
  | "plugin-panel"
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
}

export function isBrowserTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "browser";
}

export function isPluginPanelTab(file: Pick<PreviewFile, "kind">): boolean {
  return file.kind === "plugin-panel";
}

const PLUGIN_PANEL_ID_PREFIX = "plugin-panel:";

/**
 * Вкладка панельного плагина. URL относительный: панель раздаёт демон текущего
 * окружения (`/api/plugins/<id>/panel/`), а содержимое рендерится в
 * изолированном iframe — см. `PreviewPane`.
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

/**
 * Бакет вкладок одного уровня (`previewTabScopes`). Вкладки лежат в бакете
 * своего уровня; состояние вида (открыта ли панель, активная вкладка, режим
 * фокуса) держит проектный бакет — см. `viewScopeKey`.
 */
export interface PreviewBucketState {
  open: boolean;
  previewLayoutMode: "sidebar" | "focus";
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
  /** Файлы, показанные как исходный код вместо превью (для DUAL_VIEW_KINDS). */
  sourceViewFileIds: ReadonlyArray<string>;
}

interface PreviewPaneState {
  open: boolean;
  previewLayoutMode: "sidebar" | "focus";
  /** Видимые сейчас вкладки: global → project → chat, в этом порядке. */
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
  sourceViewFileIds: ReadonlyArray<string>;
  toggleSourceView: (id: string) => void;
  currentProjectKey: string;
  currentChatProjectCwd: string | null;
  /** Проект активного чата — вкладки панелей адресуют оркестрацию по нему. */
  currentChatProjectId: ProjectId | null;
  currentChatEnvironmentId: EnvironmentId | null;
  /** Тред активного чата: по нему адресуется бакет уровня `chat`. */
  currentChatThreadId: string | null;
  /** Уровень каждой видимой вкладки — для значка в ряду вкладок и меню. */
  tabScopeById: Readonly<Record<string, PreviewTabScope>>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
  togglePreviewLayoutMode: () => void;
  /** Открыть файл на уровне по умолчанию (чат текущего треда). */
  openFile: (file: PreviewFile) => void;
  /**
   * Открыть файл во вкладке конкретного треда/проекта (bridge-события
   * харнессов): вкладка попадает в бакет своего уровня, текущий вид не
   * трогается.
   */
  openFileForTarget: (target: PreviewTabTarget, scope: PreviewTabScope, file: PreviewFile) => void;
  /** Открыть URL в браузерной вкладке (без аргумента — пустая «новая вкладка»). */
  openUrl: (url?: string) => void;
  /** То же для конкретного треда/проекта и уровня — bridge-события харнессов. */
  openUrlForTarget: (target: PreviewTabTarget, scope: PreviewTabScope, url?: string) => void;
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
}

export const EMPTY_BROWSER_CONTEXT: BrowserContext = { environmentId: null, startPath: null };

export const NO_PROJECT_KEY = "__no_project__";

export const DEFAULT_PREVIEW_BUCKET_STATE: PreviewBucketState = {
  open: false,
  previewLayoutMode: "sidebar",
  files: [],
  activeFileId: null,
  browserOpen: false,
  browserContext: EMPTY_BROWSER_CONTEXT,
  editingFileId: null,
  sourceViewFileIds: [],
};

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

export function getPreviewBucketState(
  states: Readonly<Record<string, PreviewBucketState>>,
  key: string,
): PreviewBucketState {
  return states[key] ?? DEFAULT_PREVIEW_BUCKET_STATE;
}

export function applyPreviewBucketPatch(
  states: Readonly<Record<string, PreviewBucketState>>,
  key: string,
  patch: Partial<PreviewBucketState>,
): Record<string, PreviewBucketState> {
  const current = getPreviewBucketState(states, key);
  return {
    ...states,
    [key]: { ...current, ...patch },
  };
}

/**
 * Бакет, в котором лежит вкладка. `preferredKeys` (обычно — видимые сейчас
 * бакеты) просматриваются первыми: один и тот же файл может быть открыт в
 * бакетах двух разных чатов, и закрывать/переносить надо ту копию, которую
 * пользователь видит, а не чужую. null — такой вкладки нет нигде.
 */
export function findTabScopeKey(
  states: Readonly<Record<string, PreviewBucketState>>,
  id: string,
  preferredKeys: ReadonlyArray<string> = [],
): string | null {
  for (const scopeKey of preferredKeys) {
    if (states[scopeKey]?.files.some((file) => file.id === id)) return scopeKey;
  }
  for (const [scopeKey, bucket] of Object.entries(states)) {
    if (bucket.files.some((file) => file.id === id)) return scopeKey;
  }
  return null;
}

/** Видимые вкладки в порядке отображения плюс карта «вкладка → уровень». */
export function collectVisibleTabs(
  states: Readonly<Record<string, PreviewBucketState>>,
  target: PreviewTabTarget,
): {
  readonly files: ReadonlyArray<PreviewFile>;
  readonly tabScopeById: Readonly<Record<string, PreviewTabScope>>;
} {
  const files: PreviewFile[] = [];
  const tabScopeById: Record<string, PreviewTabScope> = {};
  for (const scopeKey of visibleScopeKeys(target)) {
    const bucket = states[scopeKey];
    if (!bucket) continue;
    const scope = scopeOfKey(scopeKey);
    for (const file of bucket.files) {
      files.push(file);
      tabScopeById[file.id] = scope;
    }
  }
  return { files, tabScopeById };
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

  /**
   * Состояние вида живёт в проектном бакете: переключение тредов внутри проекта
   * не должно закрывать панель и терять раскладку.
   */
  const updateViewState = useCallback(
    (updater: (prev: PreviewBucketState) => PreviewBucketState) => {
      updateBucket(viewScopeKey(currentTarget), updater);
    },
    [currentTarget, updateBucket],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      updateViewState((current) => (current.open === open ? current : { ...current, open }));
    },
    [updateViewState],
  );

  const toggleOpen = useCallback(() => {
    updateViewState((current) => ({ ...current, open: !current.open }));
  }, [updateViewState]);

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
    updateViewState((current) => ({
      ...current,
      previewLayoutMode: current.previewLayoutMode === "focus" ? "sidebar" : "focus",
      open: true,
    }));
  }, [updateViewState]);

  /**
   * Кладёт вкладку в бакет своего уровня и делает её активной в виде проекта.
   * Уже открытая вкладка (тот же id — на любом видимом уровне) не дублируется.
   */
  const openFileForTarget = useCallback(
    (target: PreviewTabTarget, scope: PreviewTabScope, file: PreviewFile) => {
      const bucketKey = scopeKeyForTarget(target, scope);
      setStatesByScopeKey((prev) => {
        const existingScopeKey = visibleScopeKeys(target).find((scopeKey) =>
          (prev[scopeKey]?.files ?? []).some((candidate) => candidate.id === file.id),
        );
        const next = { ...prev };
        if (!existingScopeKey) {
          const bucket = getPreviewBucketState(prev, bucketKey);
          next[bucketKey] = { ...bucket, files: [...bucket.files, file] };
        }
        const viewKey = viewScopeKey(target);
        const view = getPreviewBucketState(next, viewKey);
        next[viewKey] = { ...view, activeFileId: file.id, open: true };
        return next;
      });
    },
    [],
  );

  const openFile = useCallback(
    (file: PreviewFile) => {
      openFileForTarget(currentTarget, "chat", file);
    },
    [currentTarget, openFileForTarget],
  );

  const openUrlForTarget = useCallback(
    (target: PreviewTabTarget, scope: PreviewTabScope, url?: string) => {
      const trimmed = url?.trim() ?? "";
      const bucketKey = scopeKeyForTarget(target, scope);
      setStatesByScopeKey((prev) => {
        // Уже открытая вкладка с тем же URL на любом видимом уровне — фокус на неё.
        if (trimmed) {
          for (const scopeKey of visibleScopeKeys(target)) {
            const existing = (prev[scopeKey]?.files ?? []).find(
              (file) => isBrowserTab(file) && file.url === trimmed,
            );
            if (!existing) continue;
            const viewKey = viewScopeKey(target);
            const view = getPreviewBucketState(prev, viewKey);
            return { ...prev, [viewKey]: { ...view, activeFileId: existing.id, open: true } };
          }
        }
        const id = `browser-${++browserTabCounter}`;
        const tab: PreviewFile = {
          id,
          name: trimmed ? browserTabNameForUrl(trimmed) : "Новая вкладка",
          kind: "browser",
          content: "",
          url: trimmed,
          projectKey: target.projectKey,
        };
        const next = { ...prev };
        const bucket = getPreviewBucketState(prev, bucketKey);
        next[bucketKey] = { ...bucket, files: [...bucket.files, tab] };
        const viewKey = viewScopeKey(target);
        const view = getPreviewBucketState(next, viewKey);
        next[viewKey] = { ...view, activeFileId: id, open: true };
        return next;
      });
    },
    [],
  );

  const openUrl = useCallback(
    (url?: string) => {
      openUrlForTarget(currentTarget, "chat", url);
    },
    [currentTarget, openUrlForTarget],
  );

  const updateBrowserTab = useCallback(
    (scopeKey: string, id: string, patch: { url?: string; name?: string }) => {
      updateBucket(scopeKey, (current) => {
        const idx = current.files.findIndex((f) => f.id === id && isBrowserTab(f));
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

  /**
   * Перенос вкладки между уровнями: id сохраняется, поэтому у браузерной вкладки
   * не перезагружается страница (webview монтируется по id вкладки).
   */
  const setTabScope = useCallback(
    (id: string, scope: PreviewTabScope) => {
      setStatesByScopeKey((prev) => {
        const fromKey = findTabScopeKey(prev, id, visibleScopeKeys(currentTarget));
        if (!fromKey) return prev;
        const toKey = scopeKeyForTarget(currentTarget, scope);
        if (fromKey === toKey) return prev;
        const from = getPreviewBucketState(prev, fromKey);
        const tab = from.files.find((file) => file.id === id);
        if (!tab) return prev;
        const next = { ...prev };
        next[fromKey] = { ...from, files: from.files.filter((file) => file.id !== id) };
        const to = getPreviewBucketState(next, toKey);
        next[toKey] = { ...to, files: [...to.files, tab] };
        const viewKey = viewScopeKey(currentTarget);
        const view = getPreviewBucketState(next, viewKey);
        next[viewKey] = { ...view, activeFileId: id, open: true };
        return next;
      });
    },
    [currentTarget],
  );

  const closeFile = useCallback(
    (id: string) => {
      setStatesByScopeKey((prev) => {
        const scopeKey = findTabScopeKey(prev, id, visibleScopeKeys(currentTarget));
        if (!scopeKey) return prev;
        const bucket = getPreviewBucketState(prev, scopeKey);
        const closed = bucket.files.find((f) => f.id === id);
        if (!closed) return prev;
        if (closed.blobUrl) URL.revokeObjectURL(closed.blobUrl);
        const next = {
          ...prev,
          [scopeKey]: { ...bucket, files: bucket.files.filter((f) => f.id !== id) },
        };
        // Активная вкладка и режимы живут в проектном бакете, а закрытая могла
        // лежать в чужом — чистим оба.
        const viewKey = viewScopeKey(currentTarget);
        const view = getPreviewBucketState(next, viewKey);
        const remaining = collectVisibleTabs(next, currentTarget).files;
        next[viewKey] = {
          ...view,
          activeFileId: view.activeFileId === id ? (remaining[0]?.id ?? null) : view.activeFileId,
          editingFileId: view.editingFileId === id ? null : view.editingFileId,
          sourceViewFileIds: view.sourceViewFileIds.filter((existing) => existing !== id),
        };
        return next;
      });
      forgetScrollPosition(id);
    },
    [currentTarget],
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
        const viewKey = viewScopeKey(currentTarget);
        const view = getPreviewBucketState(next, viewKey);
        next[viewKey] = { ...view, editingFileId: null };
        return next;
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

  const viewState = getPreviewBucketState(statesByScopeKey, viewScopeKey(currentTarget));
  const { files, tabScopeById } = useMemo(
    () => collectVisibleTabs(statesByScopeKey, currentTarget),
    [statesByScopeKey, currentTarget],
  );

  const value = useMemo<PreviewPaneState>(
    () => ({
      open: viewState.open,
      previewLayoutMode: viewState.previewLayoutMode,
      files,
      activeFileId: viewState.activeFileId,
      browserOpen: viewState.browserOpen,
      browserContext: viewState.browserContext,
      editingFileId: viewState.editingFileId,
      sourceViewFileIds: viewState.sourceViewFileIds,
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
    }),
    [
      viewState,
      files,
      tabScopeById,
      currentProjectKey,
      currentChatProjectCwd,
      currentChatProjectId,
      currentChatEnvironmentId,
      currentChatThreadId,
      toggleSourceView,
      setOpen,
      toggleOpen,
      setPreviewLayoutMode,
      togglePreviewLayoutMode,
      openFile,
      openFileForTarget,
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
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreviewPane(): PreviewPaneState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePreviewPane must be used within PreviewPaneProvider");
  return ctx;
}

export { GLOBAL_SCOPE_KEY, projectScopeKey };
export type { PreviewTabScope, PreviewTabTarget };

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
