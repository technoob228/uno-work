/**
 * Opening a file fast (Misha 16.10 p.11: "previews as fast as possible, the
 * look unchanged"). Two round trips used to stand between a click and the
 * file: its `stat`, then its bytes. Now
 *
 * - the folder listing already has the entry: the viewer starts from it
 *   (`statFromListings`) and checks it again in the background;
 * - a press on a row (pointer down, before the click) starts reading the file
 *   (`prefetchFileForView`), so the bytes are on their way ~100 ms earlier.
 *
 * Bytes go into the same cache key the viewer's `FileSource.readBytes` uses.
 */
import type { EnvironmentId, FilesEntry, FilesListResult } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { fileKindOf } from "./fileTypes";
import { filesQueryKeys, readFileBytes } from "./filesApi";

/** Kinds the viewer reads whole as text or bytes (images/PDF stream instead). */
const READ_WHOLE: ReadonlySet<string> = new Set(["text", "code", "markdown", "html", "csv"]);
/** Don't read ahead what may never be opened: big files wait for the click. */
const PREFETCH_MAX_BYTES = 2 * 1024 * 1024;

/** The entry of `path` from any folder listing in the cache, with when it was listed. */
export function statFromListings(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  path: string,
): { entry: FilesEntry; updatedAt: number } | null {
  if (environmentId === null) return null;
  const lists = queryClient.getQueriesData<FilesListResult>({
    queryKey: ["files", "list", environmentId],
  });
  for (const [key, data] of lists) {
    const entry = data?.entries.find((candidate) => candidate.path === path);
    if (entry && entry.kind !== "directory") {
      return { entry, updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt ?? 0 };
    }
  }
  return null;
}

export function shouldPrefetch(entry: Pick<FilesEntry, "name" | "kind" | "size">): boolean {
  if (entry.kind === "directory" || entry.size > PREFETCH_MAX_BYTES) return false;
  return READ_WHOLE.has(fileKindOf(entry.name));
}

/** Start reading a file the person is about to open; harmless if they don't. */
export function prefetchFileForView(
  queryClient: QueryClient,
  environmentId: EnvironmentId | null,
  entry: FilesEntry,
): void {
  if (environmentId === null || entry.kind === "directory") return;
  const statKey = filesQueryKeys.stat(environmentId, entry.path);
  if (queryClient.getQueryData(statKey) === undefined) queryClient.setQueryData(statKey, entry);
  if (!shouldPrefetch(entry)) return;
  void queryClient
    .prefetchQuery({
      queryKey: filesQueryKeys.bytes(environmentId, entry.path, entry.modifiedAt),
      queryFn: () => readFileBytes(environmentId, entry.path),
      staleTime: Infinity,
      gcTime: 60_000,
    })
    .catch(() => undefined);
}
