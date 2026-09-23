/**
 * A file opened in Files: the header (name, what it is, actions) and the
 * opener picked for it — viewer by default, the opener's editor after Edit.
 */
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderInputIcon,
  PencilIcon,
  Share2Icon,
  TextCursorInputIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { isElectron } from "../../env";
import { isOfficeFile } from "../office/officeFormats";
import { PinPathButton } from "./PinPathButton";

import { cn } from "../../lib/utils";
import { uploadFilesFromFileList } from "../../projectUploadPickers";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { fileOpenersVersion, resolveFileOpener, subscribeFileOpeners } from "./fileOpeners";
import {
  FILE_KIND_ICON,
  FILE_KIND_LABEL,
  FILE_KIND_TINT,
  fileExtension,
  fileKindOf,
  formatFileSize,
  formatModified,
} from "./fileTypes";
import { downloadFile, filesStatQueryOptions } from "./filesApi";
import { makeFileSource } from "./fileSource";
import { ViewerLoading, ViewerMessage } from "./openers/common";
import type { useFilesUploads } from "./FilesUploads";

export function FileViewer({
  environmentId,
  path,
  uploads,
  onBack,
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  environmentId: EnvironmentId;
  path: string;
  uploads: ReturnType<typeof useFilesUploads>;
  onBack: () => void;
  onShare: (entry: FilesEntry) => void;
  onRename: (entry: FilesEntry) => void;
  onMove: (entry: FilesEntry) => void;
  onDelete: (entry: FilesEntry) => void;
}) {
  const queryClient = useQueryClient();
  const stat = useQuery(filesStatQueryOptions(environmentId, path));
  const entry = stat.data ?? null;
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState<null | (() => void)>(null);
  useSyncExternalStore(subscribeFileOpeners, fileOpenersVersion);

  const source = useMemo(
    () => (entry ? makeFileSource({ environmentId, entry, queryClient }) : null),
    // A new modification time means new bytes: rebuild the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environmentId, entry?.path, entry?.modifiedAt, entry?.size, queryClient],
  );
  const opener = source ? resolveFileOpener(source) : null;

  const guard = useCallback(
    (action: () => void) => {
      if (editing && dirty) setConfirmLeave(() => action);
      else action();
    },
    [dirty, editing],
  );

  const closeEditor = useCallback(
    (saved: boolean) => {
      setEditing(false);
      setDirty(false);
      if (saved) void stat.refetch();
    },
    [stat],
  );

  const uploadNewVersion = () => {
    if (!entry) return;
    const input = document.createElement("input");
    input.type = "file";
    const ext = fileExtension(entry.name);
    if (ext) input.accept = `.${ext}`;
    input.addEventListener("change", () => {
      const picked = input.files ? uploadFilesFromFileList(input.files)[0] : undefined;
      if (!picked) return;
      if (fileExtension(picked.relativePath) !== ext) {
        toastManager.add({
          type: "error",
          title: `Pick a .${ext} file`,
          description: `The new version replaces “${entry.name}”, so it has to be the same kind of file.`,
        });
        return;
      }
      const directory = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
      void uploads
        .start({
          targetDir: directory,
          files: [{ ...picked, relativePath: entry.name }],
          onConflict: "replace",
          label: `New version of ${entry.name}`,
        })
        .then((ok) => {
          if (ok) {
            toastManager.add({
              type: "success",
              title: "New version uploaded",
              description: entry.name,
            });
            void stat.refetch();
          }
        });
    });
    input.click();
  };

  const download = () => {
    if (!entry) return;
    void downloadFile(environmentId, entry.path).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't download",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const kind = entry ? fileKindOf(entry.name) : "other";
  const Icon = FILE_KIND_ICON[kind];
  const navigate = useNavigate();
  // Word / Excel / PowerPoint edit in Office (the full editor). Office runs from
  // the computer serving the page, so the desktop app keeps the simple editors.
  const inOffice = !isElectron && isOfficeFile(path);
  const Editor = inOffice ? undefined : opener?.Editor;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to folder"
          onClick={() => guard(onBack)}
        >
          <ArrowLeftIcon />
        </Button>
        <Icon className={cn("size-5 shrink-0", FILE_KIND_TINT[kind])} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{entry?.name ?? path.split("/").pop()}</div>
          {entry ? (
            <div className="truncate text-xs text-muted-foreground">
              {FILE_KIND_LABEL[kind]} · {formatFileSize(entry.size)} · Updated{" "}
              {formatModified(entry.modifiedAt)}
            </div>
          ) : null}
        </div>
        {entry && !editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {inOffice ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="files-open-in-office"
                onClick={() => void navigate({ to: "/office", search: { path } })}
              >
                <PencilIcon />
                <span className="hidden sm:inline">Edit in Office</span>
              </Button>
            ) : null}
            {Editor ? (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <PencilIcon />
                <span className="hidden sm:inline">{opener?.editLabel ?? "Edit"}</span>
              </Button>
            ) : null}
            <PinPathButton kind="file" path={entry.path} />
            <Button size="sm" variant="outline" onClick={download}>
              <DownloadIcon />
              <span className="hidden sm:inline">Download</span>
            </Button>
            <Button size="sm" onClick={() => onShare(entry)}>
              <Share2Icon />
              <span className="hidden sm:inline">Share</span>
            </Button>
            <Menu>
              <MenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" className="w-56">
                <MenuItem onClick={uploadNewVersion}>
                  <UploadIcon />
                  Upload a new version
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => onRename(entry)}>
                  <TextCursorInputIcon />
                  Rename
                </MenuItem>
                <MenuItem onClick={() => onMove(entry)}>
                  <FolderInputIcon />
                  Move
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => onDelete(entry)}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : null}
      </header>
      {entry && !editing && opener?.editOutsideHint ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{opener.editOutsideHint}</span>
          <span className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={download}>
              <DownloadIcon />
              Download to edit
            </Button>
            <Button size="xs" variant="outline" onClick={uploadNewVersion}>
              <UploadIcon />
              Upload new version
            </Button>
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {stat.isPending ? (
          <ViewerLoading />
        ) : stat.isError || !entry || !source ? (
          <ViewerMessage kind={kind} title="This file isn't there anymore" tone="error">
            {stat.error instanceof Error
              ? stat.error.message
              : "It may have been moved or deleted."}
          </ViewerMessage>
        ) : !opener ? (
          <ViewerMessage kind={kind} title="This file is too big to open in the browser">
            Download it to open it on your device.
          </ViewerMessage>
        ) : editing && Editor ? (
          <Editor source={source} onClose={closeEditor} onDirtyChange={setDirty} />
        ) : (
          <opener.View source={source} />
        )}
      </div>

      <AlertDialog
        open={confirmLeave !== null}
        onOpenChange={(open) => !open && setConfirmLeave(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this file will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const action = confirmLeave;
                setConfirmLeave(null);
                setEditing(false);
                setDirty(false);
                action?.();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
