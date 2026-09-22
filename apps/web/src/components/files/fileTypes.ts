/**
 * What a file *is* for a person: the kind that picks its icon, its label and
 * which opener shows it. Decided by extension only — the daemon never sniffs.
 */
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  FileVideoIcon,
  FolderIcon,
  GlobeIcon,
  PresentationIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "folder"
  | "image"
  | "pdf"
  | "html"
  | "markdown"
  | "text"
  | "code"
  | "csv"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "video"
  | "audio"
  | "archive"
  | "other";

const BY_EXTENSION: Record<string, FileKind> = {};
function register(kind: FileKind, extensions: string) {
  for (const ext of extensions.split(" ")) BY_EXTENSION[ext] = kind;
}
register("image", "png jpg jpeg gif webp avif bmp ico svg heic");
register("pdf", "pdf");
register("html", "html htm");
register("markdown", "md markdown mdx");
register("text", "txt log text rtf");
register("csv", "csv tsv");
register("spreadsheet", "xlsx xlsm xls ods numbers");
register("document", "docx doc odt pages");
register("presentation", "pptx ppt odp key");
register("video", "mp4 webm mov m4v ogv");
register("audio", "mp3 wav ogg m4a flac aac opus");
register("archive", "zip tar gz tgz bz2 xz 7z rar");
register(
  "code",
  "js mjs cjs jsx ts tsx json jsonc yaml yml toml ini cfg conf env xml css scss less py go rs rb java kt swift c h cpp hpp cs php sh bash zsh fish sql graphql vue svelte lua r dockerfile makefile gitignore editorconfig",
);

export function fileExtension(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return lower;
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : "";
}

export function fileKindOf(name: string, isDirectory = false): FileKind {
  if (isDirectory) return "folder";
  return BY_EXTENSION[fileExtension(name)] ?? "other";
}

export const FILE_KIND_ICON: Record<FileKind, LucideIcon> = {
  folder: FolderIcon,
  image: FileImageIcon,
  pdf: FileTypeIcon,
  html: GlobeIcon,
  markdown: FileTextIcon,
  text: FileTextIcon,
  code: FileCode2Icon,
  csv: TableIcon,
  spreadsheet: FileSpreadsheetIcon,
  document: FileTextIcon,
  presentation: PresentationIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  archive: FileArchiveIcon,
  other: FileIcon,
};

/** Tint per kind, so a folder of mixed files scans like a desktop. */
export const FILE_KIND_TINT: Record<FileKind, string> = {
  folder: "text-sky-500",
  image: "text-pink-500",
  pdf: "text-red-500",
  html: "text-orange-500",
  markdown: "text-slate-500",
  text: "text-slate-500",
  code: "text-violet-500",
  csv: "text-emerald-600",
  spreadsheet: "text-emerald-600",
  document: "text-blue-600",
  presentation: "text-amber-600",
  video: "text-fuchsia-500",
  audio: "text-teal-500",
  archive: "text-stone-500",
  other: "text-muted-foreground",
};

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  folder: "Folder",
  image: "Image",
  pdf: "PDF",
  html: "Web page",
  markdown: "Markdown",
  text: "Text",
  code: "Code",
  csv: "Table",
  spreadsheet: "Spreadsheet",
  document: "Document",
  presentation: "Presentation",
  video: "Video",
  audio: "Audio",
  archive: "Archive",
  other: "File",
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatModified(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** Crumbs from the files root ("Home") down to `path`. */
export function breadcrumbs(
  rootPath: string,
  path: string,
): Array<{ readonly label: string; readonly path: string }> {
  const crumbs = [{ label: "Home", path: rootPath }];
  if (!path.startsWith(rootPath) || path === rootPath) return crumbs;
  let current = rootPath;
  for (const segment of path.slice(rootPath.length).split("/").filter(Boolean)) {
    current = joinPath(current, segment);
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** `Budget.xlsx` → `Budget (edited).xlsx` — the name of a saved copy. */
export function numberedCopyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (edited)${name.slice(dot)}` : `${name} (edited)`;
}
