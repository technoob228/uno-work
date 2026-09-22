/**
 * Builds the `FileSource` an opener works with, plus the hooks viewers use to
 * get at a file's bytes, text or a loadable URL.
 */
import { FILES_RAW_ROUTE_PATH, type EnvironmentId, type FilesEntry } from "@t3tools/contracts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import type { FileSource } from "./fileOpeners";
import { fileKindOf } from "./fileTypes";
import { filesQueryKeys, readFileBytes, saveFile } from "./filesApi";

/** Kinds whose bytes the browser can stream straight from the daemon. */
const STREAMABLE = new Set(["image", "pdf", "video", "audio"]);

export function makeFileSource(input: {
  readonly environmentId: EnvironmentId;
  readonly entry: FilesEntry;
  readonly queryClient: QueryClient;
}): FileSource {
  const { environmentId, entry, queryClient } = input;
  const kind = fileKindOf(entry.name);
  const readBytes = () =>
    queryClient.fetchQuery({
      queryKey: filesQueryKeys.bytes(environmentId, entry.path, entry.modifiedAt),
      queryFn: () => readFileBytes(environmentId, entry.path),
      staleTime: Infinity,
      gcTime: 60_000,
    });
  return {
    environmentId,
    name: entry.name,
    path: entry.path,
    kind,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    readBytes,
    readText: async () => new TextDecoder("utf-8").decode(await readBytes()),
    getUrl: async (mimeType) => {
      if (isPrimaryEnvironmentId(environmentId) && STREAMABLE.has(kind)) {
        // Same machine as the page: let the browser stream it (Range, no copy).
        const url = resolvePrimaryEnvironmentHttpUrl(FILES_RAW_ROUTE_PATH, {
          path: entry.path,
          v: entry.modifiedAt,
        });
        return { url, release: () => undefined };
      }
      const url = URL.createObjectURL(new Blob([await readBytes()], { type: mimeType }));
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    save: async (contents) => {
      await saveFile(environmentId, entry.path, contents);
      await queryClient.invalidateQueries({ queryKey: filesQueryKeys.all });
    },
  };
}

function sourceKey(source: FileSource) {
  return [source.environmentId, source.path, source.modifiedAt] as const;
}

export function useFileBytes(source: FileSource) {
  return useQuery({
    queryKey: ["files", "view-bytes", ...sourceKey(source)],
    queryFn: () => source.readBytes(),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: 1,
  });
}

export function useFileText(source: FileSource) {
  return useQuery({
    queryKey: ["files", "view-text", ...sourceKey(source)],
    queryFn: () => source.readText(),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: 1,
  });
}

/** A URL for img/iframe/video, released on unmount. */
export function useFileUrl(source: FileSource, mimeType: string) {
  const [state, setState] = useState<{ url: string | null; error: Error | null }>({
    url: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    setState({ url: null, error: null });
    source.getUrl(mimeType).then(
      (result) => {
        if (cancelled) {
          result.release();
          return;
        }
        release = result.release;
        setState({ url: result.url, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ url: null, error: error instanceof Error ? error : new Error(String(error)) });
        }
      },
    );
    return () => {
      cancelled = true;
      release?.();
    };
  }, [source, mimeType]);
  return state;
}
