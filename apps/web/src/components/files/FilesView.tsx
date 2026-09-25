/**
 * Files — the computer's files, like Finder or Google Drive: browse the home
 * folder, open anything (see fileOpeners.ts), edit what the browser can edit,
 * upload and download, and share a file or folder by link.
 *
 * Route: `/files?path=<folder>&file=<file>`. Everything goes through this
 * environment's daemon (`files.*` RPCs and `/api/files/raw`).
 */
import type { EnvironmentId, FilesEntry, FilesListResult, FilesShare } from "@t3tools/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CloudIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GlobeIcon,
  LinkIcon,
  Loader2Icon,
  PlusIcon,
  PresentationIcon,
  RefreshCwIcon,
  SearchIcon,
  Share2Icon,
  TextCursorInputIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import {
  pickFilesForProjectUpload,
  pickFolderForProjectUpload,
  readDroppedUploadFiles,
} from "../../projectUploadPickers";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { DeleteDialog, MoveDialog, NameDialog } from "./FilesDialogs";
import { FileViewer } from "./FileViewer";
import { UploadPanel, useFilesUploads } from "./FilesUploads";
import {
  breadcrumbs,
  dirname,
  FILE_KIND_ICON,
  FILE_KIND_TINT,
  fileKindOf,
  formatFileSize,
  formatModified,
} from "./fileTypes";
import {
  createFile,
  downloadFile,
  filesApi,
  filesListQueryOptions,
  filesQueryKeys,
  filesSearchQueryOptions,
  filesSharesQueryOptions,
} from "./filesApi";
import { registerBuiltInFileOpeners } from "./openers";
import { PinPathButton } from "./PinPathButton";
import { ShareDialog, SharedLinksDialog } from "./ShareDialog";
import { blankExtensionFor, blankOfficeFile } from "../office/officeBlank";
import { CloudBrowser } from "./CloudBrowser";
import { CopyToCloudDialog } from "./CopyToCloudDialog";
import { FilesLocationSwitch } from "./FilesLocationSwitch";
import { prewarmOfficeEngine, readUsedKinds } from "../office/officePrewarm";

/** Let the listing load first. */
const FILES_OFFICE_PREWARM_DELAY_MS = 2_000;

registerBuiltInFileOpeners();

const INTERNAL_DRAG_TYPE = "application/x-uno-files";
type SortKey = "name" | "modified" | "size";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function sortEntries(
  entries: ReadonlyArray<FilesEntry>,
  key: SortKey,
  ascending: boolean,
): FilesEntry[] {
  const direction = ascending ? 1 : -1;
  return entries.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    const byName = left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (key === "modified") {
      return (Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt)) * direction || byName;
    }
    if (key === "size") return (left.size - right.size) * direction || byName;
    return byName * direction;
  });
}

/**
 * "New → …". Word, Excel and PowerPoint get real blank files; the file type
 * follows the extension actually typed (see `newFileContents`).
 */
const NEW_FILE_TEMPLATES = {
  word: {
    name: "Untitled.docx",
    title: "New Word document",
    contents: (): Promise<string | Uint8Array> => blankOfficeFile("docx"),
  },
  spreadsheet: {
    name: "Untitled.xlsx",
    title: "New spreadsheet",
    contents: (): Promise<string | Uint8Array> => blankOfficeFile("xlsx"),
  },
  presentation: {
    name: "Untitled.pptx",
    title: "New presentation",
    contents: (): Promise<string | Uint8Array> => blankOfficeFile("pptx"),
  },
  document: {
    name: "Untitled.md",
    title: "New text document",
    contents: async (): Promise<string | Uint8Array> => "# Untitled\n\n",
  },
  page: {
    name: "index.html",
    title: "New web page",
    contents: async (): Promise<string | Uint8Array> =>
      '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>My page</title>\n</head>\n<body>\n  <h1>Hello!</h1>\n  <p>Edit this page, then share it or publish it as a website.</p>\n</body>\n</html>\n',
  },
} as const;

/**
 * Whatever template was picked, a name ending in .docx/.xlsx/.pptx gets a
 * real blank document of that kind — never text with an office extension.
 */
function newFileContents(kind: NewFileKind, name: string): Promise<string | Uint8Array> {
  const blank = blankExtensionFor(name);
  return blank ? blankOfficeFile(blank) : NEW_FILE_TEMPLATES[kind].contents();
}
type NewFileKind = keyof typeof NEW_FILE_TEMPLATES;

type DialogState =
  | { type: "none" }
  | { type: "newFolder" }
  | { type: "newFile"; kind: NewFileKind }
  | { type: "rename"; entry: FilesEntry }
  | { type: "move"; entries: FilesEntry[] }
  | { type: "delete"; entries: FilesEntry[] }
  | { type: "share"; entry: FilesEntry }
  | { type: "links" }
  | { type: "toCloud"; entries: FilesEntry[] };

export function FilesView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const search = useSearch({ from: "/_chat/files" });
  const navigate = useNavigate({ from: "/files" });
  const queryClient = useQueryClient();
  const uploads = useFilesUploads(environmentId);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });
  const closeDialog = useCallback(() => setDialog({ type: "none" }), []);

  // Documents are opened from here: get the office engine into the browser's
  // cache in the background so the first one opens fast (officePrewarm.ts).
  useEffect(() => {
    const timer = window.setTimeout(
      () => void prewarmOfficeEngine(["word", ...readUsedKinds()]),
      FILES_OFFICE_PREWARM_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  const openFolder = useCallback(
    (path: string | undefined) => void navigate({ search: path ? { path } : {} }),
    [navigate],
  );
  const openFile = useCallback(
    (entry: Pick<FilesEntry, "path">) =>
      void navigate({ search: { path: dirname(entry.path), file: entry.path } }),
    [navigate],
  );

  const refreshAll = useCallback(
    () => queryClient.invalidateQueries({ queryKey: filesQueryKeys.all }),
    [queryClient],
  );

  const renameEntry = async (entry: FilesEntry, newName: string) => {
    const renamed = await filesApi(environmentId).rename({ path: entry.path, newName });
    await refreshAll();
    if (search.file === entry.path) openFile(renamed);
  };
  const moveEntries = async (entries: ReadonlyArray<FilesEntry>, destination: string) => {
    const result = await filesApi(environmentId).move({
      paths: entries.map((entry) => entry.path),
      destinationPath: destination,
    });
    await refreshAll();
    toastManager.add({
      type: "success",
      title: entries.length === 1 ? `Moved “${entries[0]?.name}”` : `Moved ${entries.length} items`,
    });
    const openedMoved = result.entries.find(
      (entry) => search.file && entry.name === search.file.split("/").pop(),
    );
    if (search.file && openedMoved) openFile(openedMoved);
  };
  const deleteEntries = async (entries: ReadonlyArray<FilesEntry>) => {
    const result = await filesApi(environmentId).delete({
      paths: entries.map((entry) => entry.path),
    });
    await refreshAll();
    toastManager.add({
      type: "success",
      title:
        entries.length === 1 ? `Deleted “${entries[0]?.name}”` : `Deleted ${entries.length} items`,
      ...(result.revokedShares > 0
        ? {
            description: `${result.revokedShares} share ${result.revokedShares === 1 ? "link" : "links"} turned off.`,
          }
        : {}),
    });
    if (search.file && entries.some((entry) => entry.path === search.file)) openFolder(search.path);
  };

  const listing = useQuery(filesListQueryOptions(environmentId, search.path ?? null, false));
  const rootPath = listing.data?.rootPath ?? null;
  const currentPath = listing.data?.path ?? search.path ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {search.cloud === "1" ? (
          <CloudBrowser
            environmentId={environmentId}
            bucketId={search.bucket ?? null}
            prefix={search.prefix ?? ""}
            uploads={uploads}
            onOpenComputer={() => openFolder(undefined)}
            onNavigate={(bucket, prefix) =>
              void navigate({
                search: {
                  cloud: "1",
                  ...(bucket !== null ? { bucket } : {}),
                  ...(prefix ? { prefix } : {}),
                },
              })
            }
          />
        ) : search.file && environmentId ? (
          <FileViewer
            key={search.file}
            environmentId={environmentId}
            path={search.file}
            uploads={uploads}
            onBack={() => openFolder(search.path ?? dirname(search.file!))}
            onShare={(entry) => setDialog({ type: "share", entry })}
            onRename={(entry) => setDialog({ type: "rename", entry })}
            onMove={(entry) => setDialog({ type: "move", entries: [entry] })}
            onDelete={(entry) => setDialog({ type: "delete", entries: [entry] })}
          />
        ) : (
          <FolderBrowser
            environmentId={environmentId}
            listing={listing}
            onOpenFolder={openFolder}
            onOpenFile={openFile}
            uploads={uploads}
            onDialog={setDialog}
            onOpenCloud={() => void navigate({ search: { cloud: "1" } })}
            onMoveInto={(entries, destination) =>
              moveEntries(entries, destination).catch((error: unknown) =>
                toastManager.add({
                  type: "error",
                  title: "Couldn't move",
                  description: errorText(error),
                }),
              )
            }
          />
        )}
      </div>

      <UploadPanel batches={uploads.batches} onDismiss={uploads.dismiss} />

      <NameDialog
        open={dialog.type === "newFolder"}
        title="New folder"
        initialName="Untitled folder"
        confirmLabel="Create"
        onOpenChange={(open) => !open && closeDialog()}
        onSubmit={async (name) => {
          if (!currentPath) return;
          await filesApi(environmentId).createFolder({ parentPath: currentPath, name });
          await refreshAll();
        }}
      />
      <NameDialog
        open={dialog.type === "newFile"}
        title={dialog.type === "newFile" ? NEW_FILE_TEMPLATES[dialog.kind].title : ""}
        initialName={dialog.type === "newFile" ? NEW_FILE_TEMPLATES[dialog.kind].name : ""}
        selectBaseName
        confirmLabel="Create"
        onOpenChange={(open) => !open && closeDialog()}
        onSubmit={async (name) => {
          if (!currentPath || dialog.type !== "newFile" || !environmentId) return;
          const created = await createFile(
            environmentId,
            currentPath,
            name,
            await newFileContents(dialog.kind, name),
          );
          await refreshAll();
          openFile(created);
        }}
      />
      <NameDialog
        open={dialog.type === "rename"}
        title="Rename"
        initialName={dialog.type === "rename" ? dialog.entry.name : ""}
        selectBaseName={dialog.type === "rename" && dialog.entry.kind === "file"}
        confirmLabel="Rename"
        onOpenChange={(open) => !open && closeDialog()}
        onSubmit={async (name) => {
          if (dialog.type === "rename" && name !== dialog.entry.name) {
            await renameEntry(dialog.entry, name);
          }
        }}
      />
      <DeleteDialog
        open={dialog.type === "delete"}
        entries={dialog.type === "delete" ? dialog.entries : []}
        onOpenChange={(open) => !open && closeDialog()}
        onConfirm={async () => {
          if (dialog.type === "delete") await deleteEntries(dialog.entries);
        }}
      />
      {rootPath ? (
        <MoveDialog
          open={dialog.type === "move"}
          environmentId={environmentId}
          rootPath={rootPath}
          startPath={currentPath ?? rootPath}
          entries={dialog.type === "move" ? dialog.entries : []}
          onOpenChange={(open) => !open && closeDialog()}
          onMove={async (destination) => {
            if (dialog.type === "move") await moveEntries(dialog.entries, destination);
          }}
        />
      ) : null}
      <ShareDialog
        open={dialog.type === "share"}
        environmentId={environmentId}
        entry={dialog.type === "share" ? dialog.entry : null}
        onOpenChange={(open) => !open && closeDialog()}
      />
      <CopyToCloudDialog
        open={dialog.type === "toCloud"}
        environmentId={environmentId}
        entries={dialog.type === "toCloud" ? dialog.entries : []}
        onOpenChange={(open) => !open && closeDialog()}
      />
      <SharedLinksDialog
        open={dialog.type === "links"}
        environmentId={environmentId}
        onOpenChange={(open) => !open && closeDialog()}
        onOpenItem={(share: FilesShare) =>
          share.kind === "folder" ? openFolder(share.path) : openFile(share)
        }
      />
    </SidebarInset>
  );
}

function FolderBrowser({
  environmentId,
  listing,
  onOpenFolder,
  onOpenFile,
  uploads,
  onDialog,
  onMoveInto,
  onOpenCloud,
}: {
  environmentId: EnvironmentId | null;
  listing: UseQueryResult<FilesListResult>;
  onOpenFolder: (path: string | undefined) => void;
  onOpenFile: (entry: FilesEntry) => void;
  uploads: ReturnType<typeof useFilesUploads>;
  onDialog: (dialog: DialogState) => void;
  onMoveInto: (entries: FilesEntry[], destination: string) => void;
  onOpenCloud: () => void;
}) {
  const queryClient = useQueryClient();
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: "name",
    ascending: true,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);

  const hidden = useQuery({
    ...filesListQueryOptions(environmentId, listing.data?.path ?? null, true),
    enabled: showHidden && listing.data !== undefined,
  });
  const data = showHidden ? (hidden.data ?? listing.data) : listing.data;
  const currentPath = data?.path ?? null;
  const rootPath = data?.rootPath ?? null;
  const trimmedQuery = query.trim();
  const searchResults = useQuery(filesSearchQueryOptions(environmentId, currentPath, trimmedQuery));
  const shares = useQuery(filesSharesQueryOptions(environmentId, null));
  const sharedPaths = useMemo(
    () => new Set((shares.data?.shares ?? []).map((share) => share.path)),
    [shares.data],
  );

  useEffect(() => {
    setSelected(new Set());
    setQuery("");
  }, [currentPath]);

  const entries = useMemo(() => {
    const source = trimmedQuery ? (searchResults.data?.entries ?? []) : (data?.entries ?? []);
    return sortEntries(source, sort.key, sort.ascending);
  }, [data?.entries, searchResults.data?.entries, sort, trimmedQuery]);
  const selectedEntries = entries.filter((entry) => selected.has(entry.path));

  const upload = (files: Parameters<typeof uploads.start>[0]["files"], targetDir = currentPath) => {
    if (!targetDir) return;
    void uploads.start({ targetDir, files });
  };

  const onDownload = (entry: FilesEntry) =>
    environmentId &&
    void downloadFile(environmentId, entry.path).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't download",
        description: errorText(error),
      }),
    );

  const draggedEntries = (event: React.DragEvent): FilesEntry[] | null => {
    const raw = event.dataTransfer.getData(INTERNAL_DRAG_TYPE);
    if (!raw) return null;
    try {
      const paths = new Set(JSON.parse(raw) as string[]);
      return entries.filter((entry) => paths.has(entry.path));
    } catch {
      return null;
    }
  };

  const onDropInto = (event: React.DragEvent, destination: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    setDraggingFiles(false);
    dragDepth.current = 0;
    const moving = draggedEntries(event);
    if (moving && moving.length > 0) {
      if (moving.some((entry) => entry.path === destination)) return;
      onMoveInto(moving, destination);
      return;
    }
    void readDroppedUploadFiles(event.dataTransfer).then((files) => upload(files, destination));
  };

  const createNew = (kind: NewFileKind) => onDialog({ type: "newFile", kind });

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDraggingFiles(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDraggingFiles(false);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => currentPath && onDropInto(event, currentPath)}
    >
      <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <FilesLocationSwitch
            location="computer"
            onComputer={() => onOpenFolder(undefined)}
            onCloud={() => onOpenCloud()}
          />
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm"
            aria-label="Folder"
          >
            {rootPath && currentPath ? (
              breadcrumbs(rootPath, currentPath).map((crumb, index, all) => (
                <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => onOpenFolder(index === 0 ? undefined : crumb.path)}
                    onDragOver={(event) => {
                      if (event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)) {
                        event.preventDefault();
                        setDropTarget(crumb.path);
                      }
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(event) => onDropInto(event, crumb.path)}
                    className={cn(
                      "truncate rounded-md px-1.5 py-0.5 hover:bg-accent",
                      index === all.length - 1
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                      dropTarget === crumb.path ? "bg-primary/15 ring-1 ring-primary" : "",
                    )}
                  >
                    {index === 0 ? "Files" : crumb.label}
                  </button>
                  {index < all.length - 1 ? (
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  ) : null}
                </span>
              ))
            ) : (
              <span className="font-medium">Files</span>
            )}
          </nav>
          <div className="relative hidden sm:block">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search in this folder"
              aria-label="Search files"
              className="h-8 w-56 rounded-lg border border-input bg-background pr-7 pl-8 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
          {currentPath ? <PinPathButton kind="folder" path={currentPath} /> : null}
          <Button size="sm" variant="ghost" onClick={() => onDialog({ type: "links" })}>
            <LinkIcon />
            <span className="hidden lg:inline">Shared links</span>
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" disabled={!currentPath} />}>
              <PlusIcon />
              <span className="hidden sm:inline">New</span>
            </MenuTrigger>
            <MenuPopup align="end" className="w-52">
              <MenuItem onClick={() => onDialog({ type: "newFolder" })}>
                <FolderPlusIcon />
                Folder
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => createNew("word")}>
                <FileTextIcon />
                Word document
              </MenuItem>
              <MenuItem onClick={() => createNew("spreadsheet")}>
                <FileSpreadsheetIcon />
                Spreadsheet
              </MenuItem>
              <MenuItem onClick={() => createNew("presentation")}>
                <PresentationIcon />
                Presentation
              </MenuItem>
              <MenuItem onClick={() => createNew("document")}>
                <FileTextIcon />
                Text (Markdown)
              </MenuItem>
              <MenuItem onClick={() => createNew("page")}>
                <GlobeIcon />
                Web page
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger render={<Button size="sm" disabled={!currentPath} />}>
              <UploadIcon />
              <span className="hidden sm:inline">Upload</span>
            </MenuTrigger>
            <MenuPopup align="end" className="w-48">
              <MenuItem onClick={() => pickFilesForProjectUpload((files) => upload(files))}>
                <UploadIcon />
                Files…
              </MenuItem>
              <MenuItem onClick={() => pickFolderForProjectUpload((files) => upload(files))}>
                <FolderInputIcon />
                Folder…
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="View options" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-52">
              <MenuItem onClick={() => setShowHidden((value) => !value)}>
                {showHidden ? <EyeOffIcon /> : <EyeIcon />}
                {showHidden ? "Hide hidden files" : "Show hidden files"}
              </MenuItem>
              <MenuItem
                onClick={() => void queryClient.invalidateQueries({ queryKey: filesQueryKeys.all })}
              >
                <RefreshCwIcon />
                Refresh
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <div className="relative mt-2 sm:hidden">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search in this folder"
            aria-label="Search files"
            className="h-8 w-full rounded-lg border border-input bg-background pl-8 text-sm outline-none"
          />
        </div>
      </header>

      {selectedEntries.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 sm:px-5">
          <span className="text-sm font-medium">{selectedEntries.length} selected</span>
          <span className="flex-1" />
          <Button
            size="xs"
            variant="outline"
            onClick={() => onDialog({ type: "move", entries: selectedEntries })}
          >
            <FolderInputIcon />
            Move
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={selectedEntries.some((entry) => entry.kind === "directory")}
            onClick={() => selectedEntries.forEach((entry) => onDownload(entry))}
          >
            <DownloadIcon />
            Download
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => onDialog({ type: "delete", entries: selectedEntries })}
          >
            <Trash2Icon />
            Delete
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear selection"
            onClick={() => setSelected(new Set())}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listing.isPending ? (
          <div className="flex flex-col gap-2 p-5">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        ) : listing.isError ? (
          <EmptyState
            title="Files can't reach this folder"
            detail={errorText(listing.error)}
            action={
              <Button size="sm" variant="outline" onClick={() => onOpenFolder(undefined)}>
                Go to Home
              </Button>
            }
          />
        ) : trimmedQuery && searchResults.isPending ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Searching…
          </div>
        ) : entries.length === 0 ? (
          trimmedQuery ? (
            <EmptyState
              title={`Nothing called “${trimmedQuery}” here`}
              detail="Search looks in this folder and the folders inside it."
            />
          ) : (
            <EmptyState
              title="This folder is empty"
              detail="Drop files here from your computer, or use Upload. You can also create a document, a spreadsheet or a web page."
              action={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => pickFilesForProjectUpload((files) => upload(files))}
                  >
                    <UploadIcon />
                    Upload files
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => createNew("document")}>
                    <FileTextIcon />
                    New document
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-10 py-2 pl-3 sm:pl-5">
                  <Checkbox
                    aria-label="Select all"
                    checked={
                      selectedEntries.length > 0 && selectedEntries.length === entries.length
                    }
                    indeterminate={
                      selectedEntries.length > 0 && selectedEntries.length < entries.length
                    }
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true ? new Set(entries.map((entry) => entry.path)) : new Set(),
                      )
                    }
                  />
                </th>
                <SortHeader label="Name" sortKey="name" sort={sort} onSort={setSort} />
                <SortHeader
                  label="Modified"
                  sortKey="modified"
                  sort={sort}
                  onSort={setSort}
                  className="hidden w-36 md:table-cell"
                />
                <SortHeader
                  label="Size"
                  sortKey="size"
                  sort={sort}
                  onSort={setSort}
                  className="hidden w-24 text-right sm:table-cell"
                />
                <th className="w-28 pr-3 sm:pr-5" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  shared={sharedPaths.has(entry.path)}
                  selected={selected.has(entry.path)}
                  dropTarget={dropTarget === entry.path}
                  locationHint={
                    trimmedQuery && currentPath ? relativeFolder(currentPath, entry.path) : null
                  }
                  onToggle={(value) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (value) next.add(entry.path);
                      else next.delete(entry.path);
                      return next;
                    })
                  }
                  onOpen={() =>
                    entry.kind === "directory" ? onOpenFolder(entry.path) : onOpenFile(entry)
                  }
                  onDragStart={(event) => {
                    const paths = selected.has(entry.path) ? [...selected] : [entry.path];
                    event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOverFolder={(event) => {
                    if (entry.kind !== "directory") return;
                    const types = event.dataTransfer.types;
                    if (types.includes(INTERNAL_DRAG_TYPE) || types.includes("Files")) {
                      event.preventDefault();
                      event.stopPropagation();
                      setDropTarget(entry.path);
                    }
                  }}
                  onDragLeave={() =>
                    setDropTarget((current) => (current === entry.path ? null : current))
                  }
                  onDrop={(event) => entry.kind === "directory" && onDropInto(event, entry.path)}
                  onShare={() => onDialog({ type: "share", entry })}
                  onDownload={() => onDownload(entry)}
                  onRename={() => onDialog({ type: "rename", entry })}
                  onMove={() => onDialog({ type: "move", entries: [entry] })}
                  onDelete={() => onDialog({ type: "delete", entries: [entry] })}
                  onCopyToCloud={() => onDialog({ type: "toCloud", entries: [entry] })}
                />
              ))}
            </tbody>
          </table>
        )}
        {trimmedQuery && searchResults.data?.truncated ? (
          <p className="px-5 py-3 text-xs text-muted-foreground">
            Showing the first matches. Type more of the name to narrow it down.
          </p>
        ) : null}
      </div>

      {draggingFiles ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5">
          <div className="rounded-xl bg-popover px-4 py-3 text-sm font-medium shadow-lg">
            <UploadIcon className="mr-2 inline size-4" />
            Drop to upload into {dropTarget ? `“${dropTarget.split("/").pop()}”` : "this folder"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function relativeFolder(base: string, path: string): string | null {
  const folder = dirname(path);
  if (folder === base) return null;
  return folder.startsWith(`${base}/`) ? folder.slice(base.length + 1) : folder;
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; ascending: boolean };
  onSort: (sort: { key: SortKey; ascending: boolean }) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.ascending ? ArrowUpIcon : ArrowDownIcon;
  return (
    <th className={cn("py-2 font-normal", className)}>
      <button
        type="button"
        onClick={() =>
          onSort({ key: sortKey, ascending: active ? !sort.ascending : sortKey === "name" })
        }
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? <Arrow className="size-3" /> : null}
      </button>
    </th>
  );
}

function FileRow({
  entry,
  shared,
  selected,
  dropTarget,
  locationHint,
  onToggle,
  onOpen,
  onDragStart,
  onDragOverFolder,
  onDragLeave,
  onDrop,
  onShare,
  onDownload,
  onRename,
  onMove,
  onDelete,
  onCopyToCloud,
}: {
  entry: FilesEntry;
  shared: boolean;
  selected: boolean;
  dropTarget: boolean;
  locationHint: string | null;
  onToggle: (value: boolean) => void;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOverFolder: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  onShare: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onCopyToCloud: () => void;
}) {
  const kind = fileKindOf(entry.name, entry.kind === "directory");
  const Icon = kind === "folder" ? FolderOpenIcon : FILE_KIND_ICON[kind];
  return (
    <tr
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOverFolder}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDoubleClick={onOpen}
      className={cn(
        "group border-b border-border/60 transition-colors hover:bg-accent/40",
        selected && "bg-primary/5",
        dropTarget && "bg-primary/10 outline-2 -outline-offset-2 outline-primary",
        entry.hidden && "opacity-60",
      )}
    >
      <td className="py-1.5 pl-3 sm:pl-5">
        <Checkbox
          aria-label={`Select ${entry.name}`}
          checked={selected}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
      </td>
      <td className="py-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-3 text-left"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <Icon className={cn("size-4.5", FILE_KIND_TINT[kind])} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium text-foreground group-hover:underline">
                {entry.name}
              </span>
              {shared ? (
                <span title="Shared by link" className="shrink-0 text-primary">
                  <LinkIcon className="size-3.5" />
                </span>
              ) : null}
            </span>
            {locationHint ? (
              <span className="block truncate text-xs text-muted-foreground">
                in {locationHint}
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="hidden py-1.5 text-muted-foreground md:table-cell">
        {formatModified(entry.modifiedAt)}
      </td>
      <td className="hidden py-1.5 text-right text-muted-foreground tabular-nums sm:table-cell">
        {entry.kind === "directory" ? "—" : formatFileSize(entry.size)}
      </td>
      <td className="py-1.5 pr-3 sm:pr-5">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Share ${entry.name}`}
            onClick={onShare}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Share2Icon />
          </Button>
          {entry.kind === "file" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Download ${entry.name}`}
              onClick={onDownload}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <DownloadIcon />
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`More actions for ${entry.name}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-48">
              <MenuItem onClick={onOpen}>
                <FolderOpenIcon />
                Open
              </MenuItem>
              <MenuItem onClick={onShare}>
                <Share2Icon />
                Share
              </MenuItem>
              {entry.kind === "file" ? (
                <MenuItem onClick={onDownload}>
                  <DownloadIcon />
                  Download
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onClick={onRename}>
                <TextCursorInputIcon />
                Rename
              </MenuItem>
              <MenuItem onClick={onMove}>
                <FolderInputIcon />
                Move
              </MenuItem>
              <MenuItem onClick={onCopyToCloud}>
                <CloudIcon />
                Copy to Cloud storage
              </MenuItem>
              <MenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </td>
    </tr>
  );
}

function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/60">
        <FolderOpenIcon className="size-7 text-sky-500" />
      </div>
      <div className="text-base font-medium">{title}</div>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}
