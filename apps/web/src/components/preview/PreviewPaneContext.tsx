import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

export type PreviewFileKind =
  | "md"
  | "html"
  | "pdf"
  | "xlsx"
  | "csv"
  | "json"
  | "image"
  | "text"
  | "unknown";

export interface PreviewFile {
  id: string;
  name: string;
  kind: PreviewFileKind;
  content: string;
  blobUrl?: string;
  path?: string;
  environmentId?: EnvironmentId;
}

export interface BrowserContext {
  environmentId: EnvironmentId | null;
  startPath: string | null;
}

interface PreviewPaneState {
  open: boolean;
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openFile: (file: PreviewFile) => void;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  openBrowser: (context: BrowserContext) => void;
  closeBrowser: () => void;
}

const EMPTY_BROWSER_CONTEXT: BrowserContext = { environmentId: null, startPath: null };

const Ctx = createContext<PreviewPaneState | null>(null);

export function PreviewPaneProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [files, setFiles] = useState<ReadonlyArray<PreviewFile>>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserContext, setBrowserContext] = useState<BrowserContext>(EMPTY_BROWSER_CONTEXT);

  const openFile = useCallback((file: PreviewFile) => {
    setFiles((prev) => {
      if (prev.some((f) => f.id === file.id)) return prev;
      return [...prev, file];
    });
    setActiveFileId(file.id);
    setOpen(true);
  }, []);

  const closeFile = useCallback(
    (id: string) => {
      setFiles((prev) => {
        const next = prev.filter((f) => f.id !== id);
        const closed = prev.find((f) => f.id === id);
        if (closed?.blobUrl) URL.revokeObjectURL(closed.blobUrl);
        return next;
      });
      setActiveFileId((prev) => {
        if (prev !== id) return prev;
        const remaining = files.filter((f) => f.id !== id);
        return remaining[0]?.id ?? null;
      });
    },
    [files],
  );

  const openBrowser = useCallback((context: BrowserContext) => {
    setBrowserContext(context);
    setBrowserOpen(true);
  }, []);

  const closeBrowser = useCallback(() => {
    setBrowserOpen(false);
  }, []);

  const value = useMemo<PreviewPaneState>(
    () => ({
      open,
      files,
      activeFileId,
      browserOpen,
      browserContext,
      setOpen,
      toggleOpen: () => setOpen((v) => !v),
      openFile,
      closeFile,
      setActiveFile: setActiveFileId,
      openBrowser,
      closeBrowser,
    }),
    [
      open,
      files,
      activeFileId,
      browserOpen,
      browserContext,
      openFile,
      closeFile,
      openBrowser,
      closeBrowser,
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
  "svg",
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
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
    return "image";
  }
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}
