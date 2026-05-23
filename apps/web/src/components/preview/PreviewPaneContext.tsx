import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { forgetScrollPosition } from "./previewScrollMemory";

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
  | "unknown";

export interface PreviewFile {
  id: string;
  name: string;
  kind: PreviewFileKind;
  content: string;
  blobUrl?: string;
  path?: string;
  projectCwd?: string;
  environmentId?: EnvironmentId;
}

export interface BrowserContext {
  environmentId: EnvironmentId | null;
  startPath: string | null;
}

export interface ProjectPreviewState {
  open: boolean;
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
}

interface PreviewPaneState {
  open: boolean;
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
  currentChatProjectCwd: string | null;
  currentChatEnvironmentId: EnvironmentId | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openFile: (file: PreviewFile) => void;
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
    environmentId: EnvironmentId | null;
  }) => void;
}

export const EMPTY_BROWSER_CONTEXT: BrowserContext = { environmentId: null, startPath: null };

export const NO_PROJECT_KEY = "__no_project__";

export const DEFAULT_PROJECT_PREVIEW_STATE: ProjectPreviewState = {
  open: false,
  files: [],
  activeFileId: null,
  browserOpen: false,
  browserContext: EMPTY_BROWSER_CONTEXT,
  editingFileId: null,
};

export function getProjectPreviewState(
  states: Readonly<Record<string, ProjectPreviewState>>,
  key: string,
): ProjectPreviewState {
  return states[key] ?? DEFAULT_PROJECT_PREVIEW_STATE;
}

export function applyProjectPreviewPatch(
  states: Readonly<Record<string, ProjectPreviewState>>,
  key: string,
  patch: Partial<ProjectPreviewState>,
): Record<string, ProjectPreviewState> {
  const current = getProjectPreviewState(states, key);
  return {
    ...states,
    [key]: { ...current, ...patch },
  };
}

const Ctx = createContext<PreviewPaneState | null>(null);

export function PreviewPaneProvider({ children }: { children: ReactNode }) {
  const [statesByProjectKey, setStatesByProjectKey] = useState<Record<string, ProjectPreviewState>>(
    {},
  );
  const [currentProjectKey, setCurrentProjectKey] = useState<string>(NO_PROJECT_KEY);
  const [currentChatProjectCwd, setCurrentChatProjectCwd] = useState<string | null>(null);
  const [currentChatEnvironmentId, setCurrentChatEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );

  const updateCurrentState = useCallback(
    (updater: (prev: ProjectPreviewState) => ProjectPreviewState) => {
      setStatesByProjectKey((prev) => {
        const current = getProjectPreviewState(prev, currentProjectKey);
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [currentProjectKey]: next };
      });
    },
    [currentProjectKey],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      updateCurrentState((current) => (current.open === open ? current : { ...current, open }));
    },
    [updateCurrentState],
  );

  const toggleOpen = useCallback(() => {
    updateCurrentState((current) => ({ ...current, open: !current.open }));
  }, [updateCurrentState]);

  const openFile = useCallback(
    (file: PreviewFile) => {
      updateCurrentState((current) => ({
        ...current,
        files: current.files.some((f) => f.id === file.id)
          ? current.files
          : [...current.files, file],
        activeFileId: file.id,
        open: true,
      }));
    },
    [updateCurrentState],
  );

  const closeFile = useCallback(
    (id: string) => {
      updateCurrentState((current) => {
        const closed = current.files.find((f) => f.id === id);
        if (!closed) return current;
        if (closed.blobUrl) URL.revokeObjectURL(closed.blobUrl);
        const nextFiles = current.files.filter((f) => f.id !== id);
        const nextActiveId =
          current.activeFileId === id ? (nextFiles[0]?.id ?? null) : current.activeFileId;
        const nextEditingId = current.editingFileId === id ? null : current.editingFileId;
        return {
          ...current,
          files: nextFiles,
          activeFileId: nextActiveId,
          editingFileId: nextEditingId,
        };
      });
      forgetScrollPosition(id);
    },
    [updateCurrentState],
  );

  const startEditing = useCallback(
    (id: string) => {
      updateCurrentState((current) =>
        current.editingFileId === id ? current : { ...current, editingFileId: id },
      );
    },
    [updateCurrentState],
  );

  const cancelEditing = useCallback(() => {
    updateCurrentState((current) =>
      current.editingFileId === null ? current : { ...current, editingFileId: null },
    );
  }, [updateCurrentState]);

  const applyEditedContent = useCallback(
    (id: string, content: string) => {
      updateCurrentState((current) => {
        const idx = current.files.findIndex((f) => f.id === id);
        if (idx === -1) return current;
        const updated = { ...current.files[idx]!, content };
        const nextFiles = [...current.files.slice(0, idx), updated, ...current.files.slice(idx + 1)];
        return { ...current, files: nextFiles, editingFileId: null };
      });
    },
    [updateCurrentState],
  );

  const setActiveFile = useCallback(
    (id: string) => {
      updateCurrentState((current) =>
        current.activeFileId === id ? current : { ...current, activeFileId: id },
      );
    },
    [updateCurrentState],
  );

  const openBrowser = useCallback(
    (context: BrowserContext) => {
      updateCurrentState((current) => ({
        ...current,
        browserOpen: true,
        browserContext: context,
      }));
    },
    [updateCurrentState],
  );

  const closeBrowser = useCallback(() => {
    updateCurrentState((current) =>
      current.browserOpen ? { ...current, browserOpen: false } : current,
    );
  }, [updateCurrentState]);

  const setCurrentChatContext = useCallback(
    (context: {
      projectKey: string | null;
      projectCwd: string | null;
      environmentId: EnvironmentId | null;
    }) => {
      setCurrentProjectKey(context.projectKey ?? NO_PROJECT_KEY);
      setCurrentChatProjectCwd(context.projectCwd);
      setCurrentChatEnvironmentId(context.environmentId);
    },
    [],
  );

  const currentState = getProjectPreviewState(statesByProjectKey, currentProjectKey);

  const value = useMemo<PreviewPaneState>(
    () => ({
      open: currentState.open,
      files: currentState.files,
      activeFileId: currentState.activeFileId,
      browserOpen: currentState.browserOpen,
      browserContext: currentState.browserContext,
      editingFileId: currentState.editingFileId,
      currentChatProjectCwd,
      currentChatEnvironmentId,
      setOpen,
      toggleOpen,
      openFile,
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
      currentState,
      currentChatProjectCwd,
      currentChatEnvironmentId,
      setOpen,
      toggleOpen,
      openFile,
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
