/**
 * Files, the "Tree" view (Misha 13.10): the home folder as a tree on the left,
 * the way a code editor shows a project. Folders unfold in place and stay
 * open as you go deeper; a click on a file opens it on the right, in the same
 * window, where it can be read and edited. The "List" view is the old one;
 * "Recent" puts the recent files (RecentFilesList) where the tree is.
 *
 * The choice is remembered on this device (`uno-work:files:view`); Tree is
 * the default.
 */
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GlobeIcon,
  ListIcon,
  PlusIcon,
  PresentationIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { pickFilesForProjectUpload, pickFolderForProjectUpload } from "../../projectUploadPickers";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { FILE_KIND_ICON, FILE_KIND_TINT, dirname, fileKindOf, joinPath } from "./fileTypes";
import { filesListQueryOptions, filesQueryKeys } from "./filesApi";
import { prefetchFileForView } from "./filesPrefetch";
import { useProgressiveRows } from "./useProgressiveRows";
import { FilesLocationSwitch } from "./FilesLocationSwitch";
import { FilesSearchField, FilesSearchResults, useFilesSearch } from "./FilesSearch";
import { FilesNavButtons, type FilesHistory } from "./filesHistory";
import { RecentFilesList } from "./RecentFilesList";
import type { useFilesUploads } from "./FilesUploads";

type UploadFiles = Parameters<ReturnType<typeof useFilesUploads>["start"]>[0]["files"];

export const FILES_VIEW_KEY = "uno-work:files:view";
const FILES_TREE_OPEN_KEY = "uno-work:files:tree-open";

/**
 * Tree is the default (Misha 14.10: Files works like a code editor — the tree
 * on the left, the file on the right, editable right there). Recent shares
 * its layout: the recent files on the left instead of the tree.
 */
export type FilesViewMode = "list" | "tree" | "recent";
export type FilesCreateKind =
  | "folder"
  | "word"
  | "spreadsheet"
  | "presentation"
  | "document"
  | "page";

export function useFilesViewMode(): [FilesViewMode, (mode: FilesViewMode) => void] {
  const [mode, setMode] = useLocalStorage<FilesViewMode, FilesViewMode>(
    FILES_VIEW_KEY,
    "tree",
    Schema.Literals(["list", "tree", "recent"]),
  );
  return [mode, setMode];
}

/**
 * The view actually shown: a phone has no room for two columns, so Tree
 * becomes the list there; Recent stays (one column, the file opens over it).
 */
export function effectiveFilesViewMode(stored: FilesViewMode, isMobile: boolean): FilesViewMode {
  if (!isMobile) return stored;
  return stored === "recent" ? "recent" : "list";
}

/** List | Tree | Recent, in the header of every view. */
export function FilesViewSwitch({
  mode,
  onChange,
  compact = false,
  iconsOnly = false,
}: {
  mode: FilesViewMode;
  onChange: (mode: FilesViewMode) => void;
  /** A phone: no Tree (two columns don't fit), just List | Recent. */
  compact?: boolean | undefined;
  /** The narrow tree column: labels don't fit next to the + / refresh buttons. */
  iconsOnly?: boolean | undefined;
}) {
  const label = iconsOnly ? "sr-only" : "hidden md:inline";
  const item = (active: boolean) =>
    cn(
      "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
      active
        ? "bg-background font-medium text-foreground shadow-xs"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
      role="tablist"
      aria-label="View"
      data-testid="files-view-switch"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "list"}
        className={item(mode === "list")}
        title="List"
        onClick={() => onChange("list")}
      >
        <ListIcon className="size-3.5" />
        <span className={label}>List</span>
      </button>
      {compact ? null : (
        <button
          type="button"
          role="tab"
          aria-selected={mode === "tree"}
          className={item(mode === "tree")}
          title="Tree"
          onClick={() => onChange("tree")}
        >
          <FolderTreeIcon className="size-3.5" />
          <span className={label}>Tree</span>
        </button>
      )}
      <button
        type="button"
        role="tab"
        aria-selected={mode === "recent"}
        className={item(mode === "recent")}
        title="Recent"
        onClick={() => onChange("recent")}
        data-testid="files-view-recent"
      >
        <ClockIcon className="size-3.5" />
        <span className={label}>Recent</span>
      </button>
    </div>
  );
}

/** The folders from `rootPath` down to the one holding `path` (the root included). */
export function ancestorFolders(rootPath: string, path: string): string[] {
  const root = rootPath.replace(/\/+$/, "");
  const folders = [root];
  if (!path.startsWith(`${root}/`)) return folders;
  const folder = dirname(path);
  let current = root;
  for (const segment of folder.slice(root.length).split("/").filter(Boolean)) {
    current = joinPath(current, segment);
    folders.push(current);
  }
  return folders;
}

function sortEntries(entries: ReadonlyArray<FilesEntry>): FilesEntry[] {
  return entries.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

interface TreeContext {
  readonly environmentId: EnvironmentId | null;
  readonly showHidden: boolean;
  readonly open: ReadonlySet<string>;
  readonly selectedFile: string | undefined;
  readonly currentFolder: string | undefined;
  readonly toggle: (path: string, open?: boolean) => void;
  readonly onOpenFile: (entry: FilesEntry) => void;
  readonly onSelectFolder: (path: string) => void;
  /** A press on a file row, before the click: start reading it. */
  readonly onPressFile?: (entry: FilesEntry) => void;
}

export const FilesTree = memo(function FilesTree(props: {
  environmentId: EnvironmentId | null;
  selectedFile: string | undefined;
  currentFolder: string | undefined;
  /** Gated by the caller: unsaved edits ask before the next file opens. */
  onOpenFile: (entry: FilesEntry) => void;
  onSelectFolder: (path: string) => void;
  history: FilesHistory;
  viewMode: FilesViewMode;
  onViewModeChange: (mode: FilesViewMode) => void;
  /** A phone: the switch offers List | Recent only. */
  compactSwitch?: boolean | undefined;
  onOpenCloud: () => void;
  onOpenHome: () => void;
  onCreate: (kind: FilesCreateKind) => void;
  onUpload: (files: UploadFiles) => void;
  children?: ReactNode;
}) {
  const { environmentId, selectedFile, currentFolder } = props;
  const recentMode = props.viewMode === "recent";
  const queryClient = useQueryClient();
  const [showHidden, setShowHidden] = useLocalStorage<boolean, boolean>(
    "uno-work:files:tree-hidden",
    false,
    Schema.Boolean,
  );
  const [openList, setOpenList] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    FILES_TREE_OPEN_KEY,
    [],
    Schema.Array(Schema.String),
  );
  const open = useMemo(() => new Set(openList), [openList]);
  const root = useQuery(filesListQueryOptions(environmentId, null, showHidden));
  const rootPath = root.data?.rootPath ?? null;
  const [query, setQuery] = useState("");
  const search = useFilesSearch({
    environmentId,
    folderEntries: root.data?.entries,
    scope: rootPath,
    query,
  });

  // A file opened from a link, or a rename: unfold the way down to it.
  useEffect(() => {
    if (!rootPath || !selectedFile) return;
    const needed = ancestorFolders(rootPath, selectedFile).filter((folder) => folder !== rootPath);
    if (needed.every((folder) => open.has(folder))) return;
    setOpenList((current) => [...new Set([...current, ...needed])]);
  }, [rootPath, selectedFile, open, setOpenList]);

  const toggle = (path: string, force?: boolean) =>
    setOpenList((current) => {
      const isOpen = current.includes(path);
      const next = force ?? !isOpen;
      if (next === isOpen) return current;
      return next ? [...current, path] : current.filter((entry) => entry !== path);
    });

  const onPressFile = useCallback(
    (entry: FilesEntry) => prefetchFileForView(queryClient, environmentId, entry),
    [queryClient, environmentId],
  );
  // Stable between renders, so a folder of thousands of rows (memo) doesn't
  // re-render every row when something else in Files changes.
  const context: TreeContext = useMemo(
    () => ({
      environmentId,
      showHidden,
      open,
      selectedFile,
      currentFolder,
      toggle,
      onOpenFile: props.onOpenFile,
      onSelectFolder: props.onSelectFolder,
      onPressFile,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      environmentId,
      showHidden,
      open,
      selectedFile,
      currentFolder,
      props.onOpenFile,
      props.onSelectFolder,
      onPressFile,
    ],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="files-tree">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <SidebarShowButton />
          <FilesLocationSwitch
            location="computer"
            onComputer={props.onOpenHome}
            onCloud={props.onOpenCloud}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <FilesNavButtons history={props.history} />
          <FilesViewSwitch
            mode={props.viewMode}
            onChange={props.onViewModeChange}
            compact={props.compactSwitch}
            iconsOnly
          />
          <span className="flex-1" />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="New or upload"
                  disabled={!rootPath}
                />
              }
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-52">
              <MenuItem onClick={() => props.onCreate("folder")}>
                <FolderPlusIcon />
                Folder
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => props.onCreate("word")}>
                <FileTextIcon />
                Word document
              </MenuItem>
              <MenuItem onClick={() => props.onCreate("spreadsheet")}>
                <FileSpreadsheetIcon />
                Spreadsheet
              </MenuItem>
              <MenuItem onClick={() => props.onCreate("presentation")}>
                <PresentationIcon />
                Presentation
              </MenuItem>
              <MenuItem onClick={() => props.onCreate("document")}>
                <FileTextIcon />
                Text (Markdown)
              </MenuItem>
              <MenuItem onClick={() => props.onCreate("page")}>
                <GlobeIcon />
                Web page
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => pickFilesForProjectUpload((files) => props.onUpload(files))}>
                <UploadIcon />
                Upload files…
              </MenuItem>
              <MenuItem
                onClick={() => pickFolderForProjectUpload((files) => props.onUpload(files))}
              >
                <FolderInputIcon />
                Upload folder…
              </MenuItem>
            </MenuPopup>
          </Menu>
          {recentMode ? null : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
              title={showHidden ? "Hide hidden files" : "Show hidden files"}
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void queryClient.invalidateQueries({ queryKey: filesQueryKeys.all })}
          >
            <RefreshCwIcon />
          </Button>
        </div>
        {recentMode ? null : <FilesSearchField value={query} onChange={setQuery} />}
      </div>
      {recentMode ? (
        <RecentFilesList
          environmentId={environmentId}
          rootPath={rootPath}
          selectedFile={selectedFile}
          onOpenFile={props.onOpenFile}
        />
      ) : search.active ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          <FilesSearchResults
            search={search}
            scope={rootPath}
            selectedFile={selectedFile}
            onPick={(entry) =>
              entry.kind === "directory"
                ? props.onSelectFolder(entry.path)
                : props.onOpenFile(entry)
            }
          />
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
          role="tree"
          aria-label="Files"
        >
          {root.isPending ? (
            <div className="flex flex-col gap-1.5 px-1 pt-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-5 w-full rounded-md" />
              ))}
            </div>
          ) : root.isError || !root.data ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
              This computer's files can't be read right now.
            </p>
          ) : (
            <TreeLevel entries={root.data.entries} depth={0} context={context} />
          )}
        </div>
      )}
      {props.children}
    </div>
  );
});

function TreeLevel({
  entries,
  depth,
  context,
}: {
  entries: ReadonlyArray<FilesEntry>;
  depth: number;
  context: TreeContext;
}) {
  const sorted = useMemo(() => sortEntries(entries), [entries]);
  const shown = useProgressiveRows(sorted.length);
  if (sorted.length === 0) {
    return (
      <p
        className="py-1 text-[11px] text-muted-foreground/60"
        style={{ paddingLeft: `${depth * 14 + 30}px` }}
      >
        Empty
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-px" role={depth === 0 ? undefined : "group"}>
      {(shown < sorted.length ? sorted.slice(0, shown) : sorted).map((entry) => (
        <TreeRow key={entry.path} entry={entry} depth={depth} context={context} />
      ))}
    </ul>
  );
}

const TREE_FILE_ROW_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 28px",
} as const;

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  context,
}: {
  entry: FilesEntry;
  depth: number;
  context: TreeContext;
}) {
  const isFolder = entry.kind === "directory";
  const expanded = isFolder && context.open.has(entry.path);
  const kind = fileKindOf(entry.name, isFolder);
  const Icon = FILE_KIND_ICON[kind];
  const active = !isFolder && context.selectedFile === entry.path;
  const current = isFolder && context.currentFolder === entry.path;

  const activate = () => {
    if (isFolder) {
      context.toggle(entry.path);
      context.onSelectFolder(entry.path);
    } else {
      context.onOpenFile(entry);
    }
  };

  return (
    <li
      className="list-none"
      role="treeitem"
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={active}
      // Rows off screen skip layout and paint (a folder of thousands); same look.
      style={isFolder ? undefined : TREE_FILE_ROW_STYLE}
    >
      <div
        className={cn(
          "flex h-7 items-center rounded-md pr-1.5 text-sm transition-colors",
          active
            ? "bg-primary/10 text-foreground"
            : current
              ? "bg-accent/60 text-foreground"
              : "text-foreground/90 hover:bg-accent/60",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {isFolder ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
            onClick={() => context.toggle(entry.path)}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={activate}
          onPointerDown={isFolder ? undefined : () => context.onPressFile?.(entry)}
          onKeyDown={(event) => {
            if (!isFolder) return;
            if (event.key === "ArrowRight" && !expanded) {
              event.preventDefault();
              context.toggle(entry.path, true);
            } else if (event.key === "ArrowLeft" && expanded) {
              event.preventDefault();
              context.toggle(entry.path, false);
            }
          }}
          title={entry.path}
          data-testid={isFolder ? "files-tree-folder" : "files-tree-file"}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-hidden focus-visible:underline"
        >
          <Icon className={cn("size-4 shrink-0", FILE_KIND_TINT[kind])} />
          <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
            {entry.name}
          </span>
        </button>
      </div>
      {expanded ? <TreeChildren entry={entry} depth={depth} context={context} /> : null}
    </li>
  );
});

/**
 * An open folder's contents. Its own component so only open folders hold a
 * query — a folder of 5,000 files used to mount 5,000 (disabled) queries.
 */
function TreeChildren({
  entry,
  depth,
  context,
}: {
  entry: FilesEntry;
  depth: number;
  context: TreeContext;
}) {
  const children = useQuery({
    ...filesListQueryOptions(context.environmentId, entry.path, context.showHidden),
    enabled: context.environmentId !== null,
  });
  return children.isPending ? (
    <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 14 + 30}px` }}>
      <Skeleton className="h-4 w-24 rounded" />
    </div>
  ) : children.data ? (
    <TreeLevel entries={children.data.entries} depth={depth + 1} context={context} />
  ) : (
    <p
      className="py-1 text-[11px] text-muted-foreground/60"
      style={{ paddingLeft: `${(depth + 1) * 14 + 30}px` }}
    >
      Can't be read
    </p>
  );
}
