/**
 * Finding a file by name in Files. Typing filters the folder on screen at
 * once; a moment later the computer's answer adds what's deeper, across the
 * whole project (or the home folder). Each keystroke doesn't ask: the search
 * waits for a pause, a stale answer is dropped, and on the computer a search
 * is bounded (`searchByName`: node_modules and .git skipped, 50 000 entries,
 * 2.5 s).
 */
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import {
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "../../lib/utils";
import { filesSearchQueryOptions } from "./filesApi";
import { dirname, FILE_KIND_ICON, FILE_KIND_TINT, fileKindOf } from "./fileTypes";

const SEARCH_PAUSE_MS = 200;

/** Where a search looks: the chat's project while inside it, else the home folder. */
export function filesSearchScope(input: {
  readonly currentPath: string | null;
  readonly rootPath: string | null;
  readonly projectFolder?: string | null | undefined;
}): string | null {
  const { currentPath, rootPath, projectFolder } = input;
  if (projectFolder && currentPath) {
    if (currentPath === projectFolder || currentPath.startsWith(`${projectFolder}/`)) {
      return projectFolder;
    }
  }
  return rootPath ?? currentPath;
}

export function matchFilesByName(
  entries: ReadonlyArray<FilesEntry>,
  query: string,
): ReadonlyArray<FilesEntry> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));
}

/** The folder a result is in, from where the search started; null right there. */
export function resultLocation(scope: string | null, path: string): string | null {
  const folder = dirname(path);
  if (!scope || folder === scope) return null;
  return folder.startsWith(`${scope}/`) ? folder.slice(scope.length + 1) : folder;
}

export interface FilesSearchState {
  readonly query: string;
  readonly active: boolean;
  /** What matches so far: the folder on screen first, then the computer's answer. */
  readonly entries: ReadonlyArray<FilesEntry>;
  readonly searching: boolean;
  readonly truncated: boolean;
}

export function useFilesSearch(input: {
  readonly environmentId: EnvironmentId | null;
  /** The folder on screen, filtered at once. */
  readonly folderEntries: ReadonlyArray<FilesEntry> | undefined;
  readonly scope: string | null;
  readonly query: string;
}): FilesSearchState {
  const { environmentId, folderEntries, scope } = input;
  const query = input.query.trim();
  const [pausedQuery] = useDebouncedValue(query, { wait: SEARCH_PAUSE_MS });
  const server = useQuery({
    ...filesSearchQueryOptions(environmentId, scope, pausedQuery),
    enabled: environmentId !== null && pausedQuery.length > 0 && query.length > 0,
    // The last answer stays while the next is on its way, narrowed below.
    placeholderData: keepPreviousData,
  });
  const entries = useMemo(() => {
    if (!query) return [];
    const merged = new Map<string, FilesEntry>();
    for (const entry of matchFilesByName(folderEntries ?? [], query)) {
      merged.set(entry.path, entry);
    }
    for (const entry of matchFilesByName(server.data?.entries ?? [], query)) {
      if (!merged.has(entry.path)) merged.set(entry.path, entry);
    }
    return [...merged.values()];
  }, [folderEntries, query, server.data?.entries]);
  return {
    query,
    active: query.length > 0,
    entries,
    searching: query.length > 0 && (query !== pausedQuery || server.isFetching),
    truncated: query.length > 0 && !server.isPlaceholderData && Boolean(server.data?.truncated),
  };
}

/**
 * ⌘F in Files: the search field, in whichever view it is. The root of a view
 * listens, so the key works from any row of it.
 */
export function focusFilesSearchOnFind(
  event: ReactKeyboardEvent,
  input: HTMLInputElement | null,
): void {
  if (!input) return;
  if (event.key !== "f" && event.key !== "F") return;
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation();
  input.focus();
  input.select();
}

export function FilesSearchField({
  value,
  onChange,
  inputRef,
  className,
  trailing,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("relative", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder="Search files"
        aria-label="Search files"
        data-testid="files-search-input"
        className="h-8 w-full rounded-lg border border-input bg-background pr-7 pl-8 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
      />
      {trailing}
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** What a search found, for the narrow Tree column: name and folder, a click opens. */
export function FilesSearchResults({
  search,
  scope,
  selectedFile,
  onPick,
}: {
  search: FilesSearchState;
  scope: string | null;
  selectedFile?: string | undefined;
  onPick: (entry: FilesEntry) => void;
}) {
  if (search.entries.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
        {search.searching ? (
          <>
            <Loader2Icon className="size-3.5 animate-spin" />
            Searching…
          </>
        ) : (
          `Nothing called “${search.query}” here`
        )}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-px" data-testid="files-search-results">
      {search.entries.map((entry) => {
        const kind = fileKindOf(entry.name, entry.kind === "directory");
        const Icon = FILE_KIND_ICON[kind];
        const location = resultLocation(scope, entry.path);
        return (
          <li key={entry.path} className="list-none">
            <button
              type="button"
              onClick={() => onPick(entry)}
              title={entry.path}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent/60",
                selectedFile === entry.path && "bg-primary/10",
              )}
            >
              <Icon className={cn("size-4 shrink-0", FILE_KIND_TINT[kind])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.name}</span>
                {location ? (
                  <span className="block truncate text-xs text-muted-foreground">{location}</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
      {search.truncated ? (
        <li className="list-none px-2 py-2 text-xs text-muted-foreground">
          Showing the first matches. Type more of the name to narrow it down.
        </li>
      ) : null}
    </ul>
  );
}
