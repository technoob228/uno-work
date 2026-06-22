import {
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileCode2Icon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  Loader2Icon,
  SearchIcon,
  TableIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "../../lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "../ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { detectFileKind, type PreviewFileKind, usePreviewPane } from "./PreviewPaneContext";

const KIND_ICON: Record<PreviewFileKind, typeof FileIcon> = {
  md: FileTextIcon,
  html: GlobeIcon,
  pdf: FileIcon,
  xlsx: FileSpreadsheetIcon,
  docx: FileTextIcon,
  csv: TableIcon,
  json: BracesIcon,
  image: ImageIcon,
  svg: ImageIcon,
  text: FileCode2Icon,
  browser: GlobeIcon,
  unknown: FileIcon,
};

const KIND_BG: Record<PreviewFileKind, string> = {
  md: "bg-emerald-500/16 text-emerald-700 dark:text-emerald-300",
  html: "bg-orange-500/16 text-orange-700 dark:text-orange-300",
  pdf: "bg-red-500/16 text-red-700 dark:text-red-300",
  xlsx: "bg-green-500/16 text-green-700 dark:text-green-300",
  docx: "bg-blue-500/16 text-blue-700 dark:text-blue-300",
  csv: "bg-cyan-500/16 text-cyan-700 dark:text-cyan-300",
  json: "bg-amber-500/16 text-amber-700 dark:text-amber-300",
  image: "bg-pink-500/16 text-pink-700 dark:text-pink-300",
  svg: "bg-pink-500/16 text-pink-700 dark:text-pink-300",
  text: "bg-slate-500/16 text-slate-700 dark:text-slate-300",
  browser: "bg-indigo-500/16 text-indigo-700 dark:text-indigo-300",
  unknown: "bg-muted text-muted-foreground",
};

const BROWSE_STALE_TIME_MS = 30_000;

const IGNORED_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
  ".DS_Store",
]);

function isHiddenEntry(name: string): boolean {
  return name.startsWith(".") || IGNORED_NAMES.has(name);
}

function ensureTrailingSlash(input: string): string {
  if (input === "~") return "~/";
  if (/[\\/]$/.test(input)) return input;
  return `${input}/`;
}

function stripTrailingSlash(input: string): string {
  if (input === "/" || input === "~/") return input;
  return input.replace(/[\\/]+$/, "");
}

function parentOf(input: string): string | null {
  const stripped = stripTrailingSlash(input);
  if (stripped === "/" || stripped === "~") return null;
  const idx = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return stripped.slice(0, idx);
}

function splitSegments(input: string): string[] {
  const stripped = stripTrailingSlash(input);
  if (!stripped) return [];
  return stripped.split(/[\\/]/).filter(Boolean);
}

function joinFromSegments(prefix: string, segments: string[]): string {
  if (segments.length === 0) return prefix;
  return `${prefix}/${segments.join("/")}`;
}

export function FileBrowser() {
  const { browserOpen, browserContext, closeBrowser, openFile } = usePreviewPane();
  const initialPath = browserContext.startPath ?? "~";
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (browserOpen) {
      setCurrentPath(browserContext.startPath ?? "~");
      setQuery("");
    }
  }, [browserOpen, browserContext.startPath]);

  const browseEnvironmentId = browserContext.environmentId;
  const partialPath = ensureTrailingSlash(currentPath);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["previewFileBrowser", browseEnvironmentId, partialPath],
    queryFn: async () => {
      if (!browseEnvironmentId) return null;
      const api = readEnvironmentApi(browseEnvironmentId);
      if (!api) return null;
      return api.filesystem.browse({
        partialPath,
        includeFiles: true,
      });
    },
    staleTime: BROWSE_STALE_TIME_MS,
    enabled: browserOpen && browseEnvironmentId !== null,
  });

  const entries = data?.entries ?? [];

  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((entry) => !isHiddenEntry(entry.name))),
    [entries, showHidden],
  );
  const hiddenCount = entries.length - visibleEntries.length;
  const filteredEntries = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return visibleEntries;
    return visibleEntries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [visibleEntries, query]);

  const folders = useMemo(
    () => filteredEntries.filter((entry) => entry.kind === "directory"),
    [filteredEntries],
  );
  const files = useMemo(
    () => filteredEntries.filter((entry) => entry.kind === "file"),
    [filteredEntries],
  );

  const displayPath = stripTrailingSlash(currentPath) || currentPath;
  const isHomePrefixed = displayPath.startsWith("~");
  const homePrefix = isHomePrefixed ? "~" : "";
  const segments = splitSegments(displayPath).filter((s) => s !== "~");

  const goUp = () => {
    const parent = parentOf(currentPath);
    if (parent) {
      setCurrentPath(parent);
      setQuery("");
    }
  };

  const goToBreadcrumb = (index: number) => {
    const next = joinFromSegments(homePrefix || "", segments.slice(0, index + 1));
    setCurrentPath(next || "/");
    setQuery("");
  };

  const enterFolder = (fullPath: string) => {
    setCurrentPath(fullPath);
    setQuery("");
  };

  const pickFile = (name: string, fullPath: string) => {
    const kind = detectFileKind(name);
    openFile({
      id: fullPath,
      name,
      kind,
      content: "",
      path: fullPath,
      ...(browseEnvironmentId ? { environmentId: browseEnvironmentId } : {}),
    });
    closeBrowser();
  };

  return (
    <Dialog
      open={browserOpen}
      onOpenChange={(open) => {
        if (!open) closeBrowser();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPrimitive.Popup
            data-slot="dialog-popup"
            className="-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-3xl scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <div className="flex h-[34rem] flex-col">
              <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-4 pt-4 pb-3">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={goUp}
                    disabled={parentOf(currentPath) === null}
                    aria-label="Up"
                  >
                    <ChevronLeftIcon className="size-4" />
                  </Button>
                  <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-mono text-xs text-muted-foreground">
                    {isHomePrefixed && (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setCurrentPath("~");
                            setQuery("");
                          }}
                          className={cn(
                            "rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                            segments.length === 0 && "font-medium text-foreground",
                          )}
                        >
                          ~
                        </button>
                        {segments.length > 0 && <ChevronRightIcon className="size-3 opacity-40" />}
                      </span>
                    )}
                    {segments.map((segment, index) => {
                      const isLast = index === segments.length - 1;
                      return (
                        <span
                          key={`${segment}-${index}`}
                          className="flex shrink-0 items-center gap-0.5"
                        >
                          <button
                            type="button"
                            onClick={() => goToBreadcrumb(index)}
                            className={cn(
                              "rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                              isLast && "font-medium text-foreground",
                            )}
                          >
                            {segment}
                          </button>
                          {!isLast && <ChevronRightIcon className="size-3 opacity-40" />}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1">
                  <SearchIcon className="size-3.5 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Поиск в этой папке..."
                    className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                  />
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-0.5 p-2">
                  {!browseEnvironmentId && (
                    <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                      У треда нет привязанного окружения — выберите environment
                    </div>
                  )}
                  {browseEnvironmentId && isPending && (
                    <div className="flex items-center justify-center px-4 py-12 text-sm text-muted-foreground">
                      <Loader2Icon className="mr-2 size-4 animate-spin" />
                      Загрузка...
                    </div>
                  )}
                  {browseEnvironmentId && isError && (
                    <div className="px-4 py-12 text-center text-sm text-destructive">
                      Не удалось прочитать папку:{" "}
                      {error instanceof Error ? error.message : "ошибка"}
                    </div>
                  )}
                  {browseEnvironmentId && !isPending && !isError && folders.length > 0 && (
                    <div className="px-2 pt-2 pb-1 font-medium text-[10px] uppercase tracking-wider text-muted-foreground">
                      Папки
                    </div>
                  )}
                  {folders.map((folder) => (
                    <button
                      key={folder.fullPath}
                      type="button"
                      onClick={() => enterFolder(folder.fullPath)}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <FolderIcon className="size-4 shrink-0 text-primary" />
                      <span className="flex-1 truncate font-medium">{folder.name}</span>
                    </button>
                  ))}
                  {browseEnvironmentId && !isPending && !isError && files.length > 0 && (
                    <div className="px-2 pt-3 pb-1 font-medium text-[10px] uppercase tracking-wider text-muted-foreground">
                      Файлы
                    </div>
                  )}
                  {files.map((file) => {
                    const kind = detectFileKind(file.name);
                    const Icon = KIND_ICON[kind];
                    return (
                      <button
                        key={file.fullPath}
                        type="button"
                        onClick={() => pickFile(file.name, file.fullPath)}
                        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                      >
                        <span
                          className={cn(
                            "grid size-5 shrink-0 place-items-center rounded",
                            KIND_BG[kind],
                          )}
                        >
                          <Icon className="size-3" />
                        </span>
                        <span className="flex-1 truncate">{file.name}</span>
                      </button>
                    );
                  })}
                  {browseEnvironmentId &&
                    !isPending &&
                    !isError &&
                    folders.length === 0 &&
                    files.length === 0 && (
                      <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                        Ничего не найдено
                      </div>
                    )}
                </div>
              </ScrollArea>
              <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
                <span>
                  {folders.length} папок · {files.length} файлов
                </span>
                {hiddenCount > 0 && !showHidden && (
                  <button
                    type="button"
                    onClick={() => setShowHidden(true)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                    aria-label="Показать скрытые"
                  >
                    <EyeIcon className="size-3" />
                    скрыто {hiddenCount}
                  </button>
                )}
                {showHidden && (
                  <button
                    type="button"
                    onClick={() => setShowHidden(false)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                    aria-label="Спрятать скрытые"
                  >
                    <EyeOffIcon className="size-3" />
                    спрятать скрытые
                  </button>
                )}
                <span className="ml-auto truncate font-mono">{displayPath}</span>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
