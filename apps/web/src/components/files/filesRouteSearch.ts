/**
 * `/files?path=<folder>&file=<file>` — the folder being browsed and, when set,
 * the file open on top of it. Both absolute paths on the computer. Links from
 * elsewhere (the home screen, "This computer") can open a folder or a file
 * directly: `/files?file=/home/unowork/Documents/report.docx`.
 */
export interface FilesRouteSearch {
  readonly path?: string;
  readonly file?: string;
}

function pathParam(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096
    ? value
    : undefined;
}

export function parseFilesRouteSearch(search: Record<string, unknown>): FilesRouteSearch {
  const path = pathParam(search["path"]);
  const file = pathParam(search["file"]);
  return { ...(path ? { path } : {}), ...(file ? { file } : {}) };
}
