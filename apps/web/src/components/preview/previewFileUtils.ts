import type { EnvironmentId } from "@t3tools/contracts";

import type { PreviewFile } from "./PreviewPaneContext";

export function computeRelativePath(absolutePath: string, projectCwd: string): string | null {
  const normalizedCwd = projectCwd.replace(/[\\/]+$/, "");
  if (!absolutePath.startsWith(normalizedCwd)) return null;
  return absolutePath.slice(normalizedCwd.length).replace(/^[\\/]+/, "");
}

export function resolveWriteTarget(
  file: PreviewFile,
): { cwd: string; relativePath: string } | null {
  if (!file.path) return null;
  if (file.projectCwd) {
    const rel = computeRelativePath(file.path, file.projectCwd);
    if (rel !== null) return { cwd: file.projectCwd, relativePath: rel };
  }
  const match = file.path.match(/^(.*)[\\/]([^\\/]+)$/);
  if (!match) return null;
  const [, parentDir, basename] = match;
  if (!parentDir || !basename) return null;
  return { cwd: parentDir, relativePath: basename };
}

export function parseDelimitedRows(input: string, delimiter: string): string[][] {
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

export function serializeDelimitedRows(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  delimiter: string,
): string {
  const lines = rows.map((row) =>
    row
      .map((cell) => {
        if (cell.includes('"') || cell.includes(delimiter) || /[\r\n]/.test(cell)) {
          return `"${cell.replaceAll('"', '""')}"`;
        }
        return cell;
      })
      .join(delimiter),
  );
  return lines.join("\n") + "\n";
}

export function spreadsheetColumnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

export function delimiterForFileName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext === "tsv" ? "\t" : ",";
}

/** Panel tabs that are not a file: nothing to download there. */
const NOT_A_FILE_KINDS: ReadonlySet<PreviewFile["kind"]> = new Set([
  "browser",
  "live-browser",
  "plugin-panel",
  "app",
  "tasks",
  "files",
]);

/** Where the Download button of a panel tab takes the bytes from. */
export type PreviewDownloadSource =
  /** A file of a computer: read from there (any size the Files raw route serves). */
  | { readonly kind: "computer"; readonly path: string; readonly environmentId: EnvironmentId }
  /** Bytes the app already holds (a picture pinned from a chat, an attachment preview). */
  | { readonly kind: "blob"; readonly blobUrl: string }
  /** Text the tab was opened with (a snippet from a chat). */
  | { readonly kind: "content"; readonly content: string };

/**
 * What the tab's Download button saves, or null when the tab has no file
 * (browser, app, plugin panel, tasks) or nothing to save — then the button
 * isn't shown. Every file kind the panel shows (picture, PDF, Word, Excel,
 * Markdown, code, CSV, a web page…) gets one: Katya 15.10.
 */
export function previewDownloadSource(
  file: Pick<PreviewFile, "kind" | "path" | "blobUrl" | "content" | "environmentId">,
  fallbackEnvironmentId: EnvironmentId | null,
): PreviewDownloadSource | null {
  if (NOT_A_FILE_KINDS.has(file.kind)) return null;
  const environmentId = file.environmentId ?? fallbackEnvironmentId;
  if (file.path && environmentId) {
    return { kind: "computer", path: file.path, environmentId };
  }
  if (file.blobUrl) return { kind: "blob", blobUrl: file.blobUrl };
  if (file.content.length > 0) return { kind: "content", content: file.content };
  return null;
}
