/**
 * `/files?path=<folder>&file=<file>` — the folder being browsed and, when set,
 * the file open on top of it. Both absolute paths on the computer. Links from
 * elsewhere (the home screen, "This computer") can open a folder or a file
 * directly: `/files?file=/home/unowork/Documents/report.docx`.
 */
export interface FilesRouteSearch {
  readonly path?: string;
  readonly file?: string;
  /** "1" = the Cloud storage location (the account's S3 buckets). */
  readonly cloud?: "1";
  readonly bucket?: number;
  /** Folder inside the bucket, ending in "/". */
  readonly prefix?: string;
}

function pathParam(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096
    ? value
    : undefined;
}

export function parseFilesRouteSearch(search: Record<string, unknown>): FilesRouteSearch {
  if (search["cloud"] === "1" || search["cloud"] === 1 || search["cloud"] === true) {
    const bucket = Number(search["bucket"]);
    const prefix = typeof search["prefix"] === "string" ? search["prefix"] : "";
    return {
      cloud: "1",
      ...(Number.isInteger(bucket) && bucket > 0 ? { bucket } : {}),
      ...(prefix && prefix.endsWith("/") && !prefix.includes("..") ? { prefix } : {}),
    };
  }
  const path = pathParam(search["path"]);
  const file = pathParam(search["file"]);
  return { ...(path ? { path } : {}), ...(file ? { file } : {}) };
}
