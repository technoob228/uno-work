import {
  BracesIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCode2Icon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  Loader2Icon,
  TableIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../lib/utils";
import { openInPreferredEditor } from "../../editorPreferences";
import { readEnvironmentApi } from "../../environmentApi";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { type PreviewFile, type PreviewFileKind, usePreviewPane } from "./PreviewPaneContext";

const KIND_ICON: Record<PreviewFileKind, typeof FileIcon> = {
  md: FileTextIcon,
  html: GlobeIcon,
  pdf: FileIcon,
  xlsx: FileSpreadsheetIcon,
  csv: TableIcon,
  json: BracesIcon,
  image: ImageIcon,
  text: FileCode2Icon,
  unknown: FileIcon,
};

const KIND_LABEL: Record<PreviewFileKind, string> = {
  md: "Markdown",
  html: "HTML",
  pdf: "PDF",
  xlsx: "Spreadsheet",
  csv: "Table",
  json: "JSON",
  image: "Image",
  text: "Text",
  unknown: "File",
};

const PREVIEW_WIDTH_STORAGE_KEY = "preview_pane_width";
const DEFAULT_PREVIEW_WIDTH = 24 * 16;
const MIN_PREVIEW_WIDTH = 22 * 16;

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_PREVIEW_WIDTH;
  const raw = window.localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY);
  if (!raw) return DEFAULT_PREVIEW_WIDTH;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PREVIEW_WIDTH;
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="preview-markdown px-5 py-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function HtmlBody({ file }: { file: PreviewFile }) {
  const src = file.blobUrl;
  if (src) {
    return <iframe title={file.name} src={src} sandbox="" className="h-full w-full border-0" />;
  }
  return (
    <iframe title={file.name} srcDoc={file.content} sandbox="" className="h-full w-full border-0" />
  );
}

function openFileInEditor(path: string) {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({ type: "error", title: "Open in editor is unavailable" });
    return;
  }
  void openInPreferredEditor(api, path).catch((error) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open file",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}

function MetadataPlaceholder({ file, label }: { file: PreviewFile; label: string }) {
  const Icon = KIND_ICON[file.kind];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-lg bg-muted p-3 text-muted-foreground">
        <Icon className="size-8" />
      </div>
      <div className="text-sm font-medium">{file.name}</div>
      {file.path ? (
        <div className="max-w-full truncate font-mono text-xs text-muted-foreground">
          {file.path}
        </div>
      ) : null}
      <div className="text-xs text-muted-foreground">{label}</div>
      {file.path ? (
        <Button size="sm" variant="outline" onClick={() => openFileInEditor(file.path!)}>
          Открыть в редакторе
        </Button>
      ) : null}
      {file.blobUrl ? (
        <Button
          size="sm"
          variant="outline"
          render={<a href={file.blobUrl} target="_blank" rel="noreferrer" download={file.name} />}
        >
          Открыть внешне
        </Button>
      ) : null}
    </div>
  );
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

function parseDelimitedRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      current.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((row) => row.length > 1 || (row[0] ?? "").length > 0);
}

const CSV_MAX_ROWS = 500;

function CsvBody({ file, content }: { file: PreviewFile; content: string }) {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const delimiter = ext === "tsv" ? "\t" : ",";
  const rows = useMemo(() => parseDelimitedRows(content, delimiter), [content, delimiter]);
  if (rows.length === 0) {
    return <MetadataPlaceholder file={file} label="Пустая таблица" />;
  }
  const header = rows[0]!;
  const body = rows.slice(1, CSV_MAX_ROWS + 1);
  const truncated = rows.length - 1 > CSV_MAX_ROWS;
  return (
    <ScrollArea className="h-full">
      <div className="p-3 text-xs">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted">
              {header.map((cell, idx) => (
                <th
                  key={idx}
                  className="border border-border px-2 py-1.5 text-left font-medium text-foreground"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-muted/50">
                {header.map((_, colIdx) => (
                  <td
                    key={colIdx}
                    className="border border-border px-2 py-1 align-top text-muted-foreground"
                  >
                    {row[colIdx] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated ? (
          <div className="mt-2 text-center text-[10px] text-muted-foreground">
            Показаны первые {CSV_MAX_ROWS} строк из {rows.length - 1}.
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function JsonBody({ content }: { content: string }) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }, [content]);
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre px-4 py-3 font-mono text-xs leading-relaxed">{formatted}</pre>
    </ScrollArea>
  );
}

function TextBody({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed">
        {content}
      </pre>
    </ScrollArea>
  );
}

interface LoadedFileData {
  content: string;
  encoding: "utf8" | "base64";
  mimeType?: string | undefined;
  blobUrl?: string | undefined;
}

function renderLoadedBody(file: PreviewFile, data: LoadedFileData) {
  if (data.encoding === "utf8") {
    if (file.kind === "md") {
      return (
        <ScrollArea className="h-full">
          <MarkdownBody content={data.content} />
        </ScrollArea>
      );
    }
    if (file.kind === "html") {
      return (
        <iframe
          title={file.name}
          srcDoc={data.content}
          sandbox=""
          className="h-full w-full border-0"
        />
      );
    }
    if (file.kind === "csv") {
      return <CsvBody file={file} content={data.content} />;
    }
    if (file.kind === "json") {
      return <JsonBody content={data.content} />;
    }
    if (file.kind === "text" || file.kind === "unknown" || file.kind === "xlsx") {
      return <TextBody content={data.content} />;
    }
  }

  if (data.encoding === "base64" && data.blobUrl) {
    if (file.kind === "pdf") {
      return <iframe title={file.name} src={data.blobUrl} className="h-full w-full border-0" />;
    }
    if (file.kind === "html") {
      return (
        <iframe
          title={file.name}
          src={data.blobUrl}
          sandbox=""
          className="h-full w-full border-0"
        />
      );
    }
    if (file.kind === "image") {
      return (
        <ScrollArea className="h-full">
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={data.blobUrl}
              alt={file.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </ScrollArea>
      );
    }
  }

  return <MetadataPlaceholder file={file} label="Формат пока не поддерживается" />;
}

function LoadedBody({ file }: { file: PreviewFile }) {
  const path = file.path;
  const environmentId = file.environmentId;

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["previewReadFile", environmentId, path],
    queryFn: async () => {
      if (!path || !environmentId) return null;
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error("Окружение недоступно");
      return api.filesystem.readFile({ path });
    },
    enabled: Boolean(path && environmentId),
    staleTime: 30_000,
  });

  const blobUrl = useMemo(() => {
    if (!data || data.encoding !== "base64") return undefined;
    const mime = data.mimeType ?? "application/octet-stream";
    return base64ToBlobUrl(data.content, mime);
  }, [data]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        Загрузка файла...
      </div>
    );
  }
  if (isError) {
    return (
      <MetadataPlaceholder
        file={file}
        label={error instanceof Error ? error.message : "Не удалось прочитать файл"}
      />
    );
  }
  if (!data) {
    return <MetadataPlaceholder file={file} label="Нет данных" />;
  }

  return renderLoadedBody(file, { ...data, ...(blobUrl ? { blobUrl } : {}) });
}

function Body({ file }: { file: PreviewFile }) {
  const hasInlineContent = Boolean(file.content) || Boolean(file.blobUrl);

  if (!hasInlineContent && file.path && file.environmentId) {
    return <LoadedBody file={file} />;
  }

  if (!hasInlineContent) {
    return <MetadataPlaceholder file={file} label="Нет данных для предпросмотра" />;
  }

  switch (file.kind) {
    case "md":
      return (
        <ScrollArea className="h-full">
          <MarkdownBody content={file.content} />
        </ScrollArea>
      );
    case "html":
      return <HtmlBody file={file} />;
    case "csv":
      return <CsvBody file={file} content={file.content} />;
    case "json":
      return <JsonBody content={file.content} />;
    case "text":
      return <TextBody content={file.content} />;
    case "pdf":
      return <MetadataPlaceholder file={file} label="PDF доступен только из файловой системы" />;
    case "xlsx":
      return <MetadataPlaceholder file={file} label="Excel-таблицы пока не поддерживаются" />;
    default:
      return <MetadataPlaceholder file={file} label="Формат не поддерживается" />;
  }
}

const MAX_VISIBLE_DIR_SEGMENTS = 3;

function PathBar({ file, onOpenBrowser }: { file: PreviewFile; onOpenBrowser: () => void }) {
  const rawPath = file.path ?? file.name;
  const displayPath = rawPath.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  const segments = displayPath.split(/[\\/]/).filter(Boolean);
  const fileSegment = segments.length > 0 ? segments[segments.length - 1] : file.name;
  const dirSegments = segments.slice(0, -1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawPath);
      setCopied(true);
    } catch {
      // ignore copy failures
    }
  }, [rawPath]);

  const collapsed = dirSegments.length > MAX_VISIBLE_DIR_SEGMENTS;
  const visibleDirSegments = collapsed
    ? [
        { kind: "segment" as const, label: dirSegments[0]!, key: "first" },
        { kind: "ellipsis" as const, key: "ellipsis" },
        ...dirSegments.slice(-2).map((label, index) => ({
          kind: "segment" as const,
          label,
          key: `tail-${index}`,
        })),
      ]
    : dirSegments.map((label, index) => ({
        kind: "segment" as const,
        label,
        key: `${label}-${index}`,
      }));

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-2 text-xs"
      title={rawPath}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onOpenBrowser}
        aria-label="Browse files"
        className="shrink-0"
      >
        <FolderIcon className="size-3.5" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono text-[11px] text-muted-foreground">
        {visibleDirSegments.map((entry) =>
          entry.kind === "ellipsis" ? (
            <span key={entry.key} className="flex shrink-0 items-center gap-0.5">
              <span className="px-1 py-0.5 opacity-60">…</span>
              <ChevronRightIcon className="size-3 opacity-40" />
            </span>
          ) : (
            <span key={entry.key} className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onOpenBrowser}
                className="rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
              >
                {entry.label}
              </button>
              <ChevronRightIcon className="size-3 opacity-40" />
            </span>
          ),
        )}
        <span className="truncate px-1 py-0.5 font-medium text-foreground">{fileSegment}</span>
      </div>
      <TooltipProvider delay={0} closeDelay={0}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={handleCopyPath}
                aria-label="Copy path"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-emerald-500" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </button>
            }
          />
          <TooltipPopup side="bottom">{copied ? "Copied!" : "Copy path"}</TooltipPopup>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function PreviewPane() {
  const { open, files, activeFileId, setActiveFile, closeFile, setOpen, openBrowser } =
    usePreviewPane();
  const [width, setWidth] = useState<number>(() => readStoredWidth());
  const [maxWidth, setMaxWidth] = useState<number>(() =>
    typeof window !== "undefined" ? Math.max(MIN_PREVIEW_WIDTH, window.innerWidth * 0.6) : 800,
  );
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setMaxWidth(Math.max(MIN_PREVIEW_WIDTH, window.innerWidth * 0.6));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistWidth = useCallback((next: number) => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(Math.round(next)));
  }, []);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      dragStateRef.current = { startX: event.clientX, startWidth: width };
      document.body.style.setProperty("cursor", "ew-resize");
      document.body.style.setProperty("user-select", "none");
    },
    [width],
  );

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state) return;
      const delta = state.startX - event.clientX;
      const next = Math.min(maxWidth, Math.max(MIN_PREVIEW_WIDTH, state.startWidth + delta));
      setWidth(next);
    },
    [maxWidth],
  );

  const handleResizePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state) return;
      dragStateRef.current = null;
      const handle = event.currentTarget;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      persistWidth(width);
    },
    [persistWidth, width],
  );

  const clampedWidth = Math.min(maxWidth, Math.max(MIN_PREVIEW_WIDTH, width));

  if (!open || files.length === 0) {
    return null;
  }

  const active = files.find((f) => f.id === activeFileId) ?? files[0];

  const handleOpenBrowser = () => {
    if (!active) return;
    const dir = active.path ? active.path.replace(/[\\/][^\\/]*$/, "") : null;
    openBrowser({
      environmentId: active.environmentId ?? null,
      startPath: dir || null,
    });
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
      style={{ width: `${clampedWidth}px` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        className="absolute left-0 top-0 z-30 h-full w-1.5 -translate-x-1/2 cursor-ew-resize hover:bg-primary/30 active:bg-primary/50"
      />
      <header className="relative flex h-9 shrink-0 items-center border-b border-border bg-card pr-2">
        <div
          className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
          style={{
            maskImage: "linear-gradient(to right, black calc(100% - 1.5rem), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, black calc(100% - 1.5rem), transparent 100%)",
          }}
        >
          {files.map((file) => {
            const Icon = KIND_ICON[file.kind];
            const isActive = file.id === active?.id;
            return (
              <button
                key={file.id}
                type="button"
                onClick={() => setActiveFile(file.id)}
                className={cn(
                  "group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                title={`${KIND_LABEL[file.kind]} — ${file.name}`}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="max-w-[8rem] truncate">{file.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(file.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      closeFile(file.id);
                    }
                  }}
                >
                  <XIcon className="size-3" />
                </span>
              </button>
            );
          })}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setOpen(false)}
          aria-label="Закрыть панель"
          className="relative shrink-0"
        >
          <XIcon />
        </Button>
      </header>
      {active ? <PathBar file={active} onOpenBrowser={handleOpenBrowser} /> : null}
      <div className="min-h-0 flex-1">{active ? <Body file={active} /> : null}</div>
    </aside>
  );
}
