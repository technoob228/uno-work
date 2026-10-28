/**
 * Content types by file extension for files this computer hands out: the
 * workspace file reader and mail attachments (`unoWork/mailTools.ts`).
 * Anything not listed is `application/octet-stream`.
 */
import nodePath from "node:path";

export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
};

const EXTRA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".ics": "text/calendar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

export function mimeTypeForFileName(name: string): string {
  const ext = nodePath.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? EXTRA_MIME_BY_EXT[ext] ?? "application/octet-stream";
}
