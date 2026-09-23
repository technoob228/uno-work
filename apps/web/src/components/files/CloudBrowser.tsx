/**
 * "Cloud storage" in Files — the Uno account's S3 buckets as a second disk.
 * Buckets at the top level (with how much space each uses), folders and files
 * inside. Uploads go browser → this computer (hidden staging folder) → cloud,
 * so the browser never needs S3 CORS; downloads open a presigned link.
 */
import type { EnvironmentId, FilesCloudObject } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CloudIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderDownIcon,
  FolderOpenIcon,
  LinkIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { isOfficeFile } from "../office/officeFormats";
import {
  pickFilesForProjectUpload,
  pickFolderForProjectUpload,
  readDroppedUploadFiles,
} from "../../projectUploadPickers";
import type { ProjectUploadFile } from "../../projectUpload";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { MoveDialog, NameDialog } from "./FilesDialogs";
import { FilesLocationSwitch } from "./FilesLocationSwitch";
import type { useFilesUploads } from "./FilesUploads";
import {
  FILE_KIND_ICON,
  FILE_KIND_TINT,
  fileKindOf,
  formatFileSize,
  formatModified,
  joinPath,
} from "./fileTypes";
import {
  cloudListQueryOptions,
  cloudStateQueryOptions,
  filesApi,
  filesListQueryOptions,
  filesQueryKeys,
} from "./filesApi";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function formatQuota(used: number, quota: number): string {
  const gb = (bytes: number) => {
    const value = bytes / 1024 ** 3;
    return value >= 10 ? Math.round(value).toString() : value.toFixed(value >= 1 ? 1 : 2);
  };
  return quota > 0 ? `${gb(used)} of ${gb(quota)} GB used` : `${formatFileSize(used)} used`;
}

export function CloudUsageBar({ used, quota }: { used: number; quota: number }) {
  if (quota <= 0) return null;
  const percent = Math.min(100, Math.round((used / quota) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", percent >= 90 ? "bg-destructive" : "bg-sky-500")}
        style={{ width: `${Math.max(2, percent)}%` }}
      />
    </div>
  );
}

type CloudTarget = { key: string; name: string; isFolder: boolean };

export function CloudBrowser({
  environmentId,
  bucketId,
  prefix,
  uploads,
  onNavigate,
  onOpenComputer,
}: {
  environmentId: EnvironmentId | null;
  bucketId: number | null;
  prefix: string;
  uploads: ReturnType<typeof useFilesUploads>;
  onNavigate: (bucketId: number | null, prefix: string) => void;
  onOpenComputer: () => void;
}) {
  const queryClient = useQueryClient();
  const state = useQuery(cloudStateQueryOptions(environmentId));
  const listing = useQuery({
    ...cloudListQueryOptions(environmentId, bucketId ?? 0, prefix),
    enabled: environmentId !== null && bucketId !== null,
  });
  const home = useQuery(filesListQueryOptions(environmentId, null, false));
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState<CloudTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CloudTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["files", "cloud"] });
  const bucket =
    state.data?.buckets.find((candidate) => candidate.id === bucketId) ?? listing.data?.bucket;

  /** Browser → hidden folder on this computer → the bucket, then clean up. */
  const uploadToCloud = async (files: ProjectUploadFile[]) => {
    const rootPath = home.data?.rootPath;
    if (!rootPath || bucketId === null || files.length === 0 || !environmentId) return;
    const staging = joinPath(rootPath, `.uno-cloud-upload-${Date.now().toString(36)}`);
    const ok = await uploads.start({
      targetDir: staging,
      files,
      label: `Uploading to ${bucket?.name ?? "Cloud storage"}`,
    });
    if (!ok) return;
    const topLevel = [...new Set(files.map((file) => file.relativePath.split("/")[0]!))];
    const toastId = toastManager.add({
      type: "loading",
      title: "Sending to Cloud storage…",
      timeout: 0,
    });
    try {
      const result = await filesApi(environmentId).cloudCopyToCloud({
        paths: topLevel.map((name) => joinPath(staging, name)),
        bucketId,
        prefix,
        removeSource: true,
      });
      toastManager.close(toastId);
      toastManager.add({
        type: result.skipped.length > 0 ? "warning" : "success",
        title: `${result.files} ${result.files === 1 ? "file" : "files"} in ${bucket?.name ?? "Cloud storage"}`,
        ...(result.skipped.length > 0
          ? {
              description: `Left out: ${result.skipped.map((item) => `${item.name} (${item.reason})`).join(", ")}`,
            }
          : {}),
      });
    } catch (error) {
      toastManager.close(toastId);
      toastManager.add({
        type: "error",
        title: "Couldn't upload to Cloud storage",
        description: errorText(error),
      });
    } finally {
      await filesApi(environmentId)
        .delete({ paths: [staging] })
        .catch(() => undefined);
      refresh();
    }
  };

  const navigate = useNavigate();
  // Word/Excel/PowerPoint open in Office and save back into the bucket. Office
  // runs on the computer serving the page, so not in the desktop app.
  // Older copies under `.versions/` only download.
  const opensInOffice = (key: string) =>
    !isElectron && isOfficeFile(key) && bucketId !== null && !key.split("/").includes(".versions");
  const openInOffice = (object: FilesCloudObject) => {
    if (bucketId === null) return;
    void navigate({ to: "/office", search: { bucket: bucketId, key: object.key } });
  };

  const download = async (object: FilesCloudObject) => {
    if (bucketId === null) return;
    try {
      const { url } = await filesApi(environmentId).cloudDownloadUrl({ bucketId, key: object.key });
      window.open(url, "_blank", "noopener");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't download",
        description: errorText(error),
      });
    }
  };

  const header = (
    <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <FilesLocationSwitch
          location="cloud"
          onComputer={onOpenComputer}
          onCloud={() => onNavigate(null, "")}
        />
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm"
          aria-label="Folder"
        >
          {bucketId !== null ? (
            <>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              <button
                type="button"
                onClick={() => onNavigate(bucketId, "")}
                className={cn(
                  "truncate rounded-md px-1.5 py-0.5 hover:bg-accent",
                  prefix ? "text-muted-foreground" : "font-medium",
                )}
              >
                {bucket?.name ?? "Bucket"}
              </button>
              {prefix
                .split("/")
                .filter(Boolean)
                .map((segment, index, all) => {
                  const target = `${all.slice(0, index + 1).join("/")}/`;
                  return (
                    <span key={target} className="flex min-w-0 items-center gap-0.5">
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <button
                        type="button"
                        onClick={() => onNavigate(bucketId, target)}
                        className={cn(
                          "truncate rounded-md px-1.5 py-0.5 hover:bg-accent",
                          index === all.length - 1 ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {segment}
                      </button>
                    </span>
                  );
                })}
            </>
          ) : null}
        </nav>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={refresh}>
          <RefreshCwIcon />
        </Button>
        {bucketId === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!state.data?.available}
            onClick={() => setNewBucketOpen(true)}
          >
            <PlusIcon />
            New bucket
          </Button>
        ) : (
          <Menu>
            <MenuTrigger render={<Button size="sm" disabled={busy || !home.data} />}>
              <UploadIcon />
              <span className="hidden sm:inline">Upload</span>
            </MenuTrigger>
            <MenuPopup align="end" className="w-48">
              <MenuItem
                onClick={() => pickFilesForProjectUpload((files) => void uploadToCloud(files))}
              >
                <UploadIcon />
                Files…
              </MenuItem>
              <MenuItem
                onClick={() => pickFolderForProjectUpload((files) => void uploadToCloud(files))}
              >
                <FolderOpenIcon />
                Folder…
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
      </div>
    </header>
  );

  let body: React.ReactNode;
  if (state.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (!state.data?.available) {
    body = (
      <CloudEmpty
        title="Cloud storage isn't connected"
        detail={state.data?.message ?? errorText(state.error)}
      />
    );
  } else if (bucketId === null) {
    body = (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/10">
              <CloudIcon className="size-5 text-sky-500" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Cloud storage</div>
              <div className="text-xs text-muted-foreground">
                {formatQuota(state.data.usedBytes, state.data.quotaBytes)} · part of your Uno plan,
                reachable from every computer on your account
              </div>
            </div>
          </div>
          <div className="mt-3">
            <CloudUsageBar used={state.data.usedBytes} quota={state.data.quotaBytes} />
          </div>
          {state.data.overQuota ? (
            <p className="mt-2 text-xs text-destructive">
              Storage is full: uploads are paused until you free up space.
            </p>
          ) : null}
        </div>
        {state.data.buckets.length === 0 ? (
          <CloudEmpty
            title="No buckets yet"
            detail="A bucket is a top-level folder in Cloud storage. Create one to start keeping files there."
            action={
              <Button size="sm" onClick={() => setNewBucketOpen(true)}>
                <PlusIcon />
                New bucket
              </Button>
            }
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {state.data.buckets.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id, "")}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted/60">
                  <CloudIcon className="size-4.5 text-sky-500" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatFileSize(item.usedBytes)}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (listing.isPending) {
    body = (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Opening…
      </div>
    );
  } else if (listing.isError || !listing.data) {
    body = <CloudEmpty title="Couldn't open this bucket" detail={errorText(listing.error)} />;
  } else if (!listing.data.listingSupported) {
    body = (
      <CloudEmpty
        title="Browsing this bucket needs a console update"
        detail="Uploading here works now. Seeing and downloading what's inside arrives with the next Uno console update."
      />
    );
  } else if (listing.data.folders.length === 0 && listing.data.objects.length === 0) {
    body = (
      <CloudEmpty
        title="This folder is empty"
        detail="Drop files here, use Upload, or send files from This computer with “Copy to Cloud storage”."
      />
    );
  } else {
    const rows: CloudTarget[] = [
      ...listing.data.folders.map((folder) => ({
        key: folder.prefix,
        name: folder.name,
        isFolder: true,
      })),
      ...listing.data.objects.map((object) => ({
        key: object.key,
        name: object.name,
        isFolder: false,
      })),
    ];
    const objectsByKey = new Map(listing.data.objects.map((object) => [object.key, object]));
    body = (
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 pl-3 font-normal sm:pl-5">Name</th>
            <th className="hidden w-36 py-2 font-normal md:table-cell">Modified</th>
            <th className="hidden w-24 py-2 text-right font-normal sm:table-cell">Size</th>
            <th className="w-24 pr-3 sm:pr-5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const object = objectsByKey.get(row.key);
            const kind = fileKindOf(row.name, row.isFolder);
            const Icon = row.isFolder ? FolderOpenIcon : FILE_KIND_ICON[kind];
            return (
              <tr key={row.key} className="group border-b border-border/60 hover:bg-accent/40">
                <td className="py-1.5 pl-3 sm:pl-5">
                  <button
                    type="button"
                    onClick={() =>
                      row.isFolder
                        ? onNavigate(bucketId, row.key)
                        : object &&
                          (opensInOffice(row.key) ? openInOffice(object) : void download(object))
                    }
                    className="flex w-full min-w-0 items-center gap-3 text-left"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                      <Icon className={cn("size-4.5", FILE_KIND_TINT[kind])} />
                    </span>
                    <span className="truncate font-medium group-hover:underline">{row.name}</span>
                  </button>
                </td>
                <td className="hidden py-1.5 text-muted-foreground md:table-cell">
                  {object?.modifiedAt ? formatModified(object.modifiedAt) : ""}
                </td>
                <td className="hidden py-1.5 text-right text-muted-foreground tabular-nums sm:table-cell">
                  {object ? formatFileSize(object.size) : "—"}
                </td>
                <td className="py-1.5 pr-3 sm:pr-5">
                  <div className="flex items-center justify-end gap-0.5">
                    {object ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Download ${row.name}`}
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => void download(object)}
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
                            aria-label={`More actions for ${row.name}`}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end" className="w-52">
                        {object && opensInOffice(row.key) ? (
                          <MenuItem onClick={() => openInOffice(object)}>
                            <PencilIcon />
                            Open in Office
                          </MenuItem>
                        ) : null}
                        {object ? (
                          <MenuItem onClick={() => void download(object)}>
                            <DownloadIcon />
                            Download
                          </MenuItem>
                        ) : null}
                        {object && isOfficeFile(row.name) ? (
                          <MenuItem disabled>
                            <LinkIcon />
                            Share link — not yet for Cloud
                          </MenuItem>
                        ) : null}
                        <MenuItem onClick={() => setCopyTarget(row)}>
                          <FolderDownIcon />
                          Copy to this computer
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => setDeleteTarget(row)}>
                          <Trash2Icon />
                          Delete
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        if (bucketId !== null && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (bucketId === null) return;
        event.preventDefault();
        setDragging(false);
        void readDroppedUploadFiles(event.dataTransfer).then((files) => uploadToCloud(files));
      }}
    >
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-sky-500 bg-sky-500/5">
          <div className="rounded-xl bg-popover px-4 py-3 text-sm font-medium shadow-lg">
            <UploadIcon className="mr-2 inline size-4" />
            Drop to upload to {bucket?.name ?? "Cloud storage"}
          </div>
        </div>
      ) : null}

      <NameDialog
        open={newBucketOpen}
        title="New bucket"
        description="Lowercase letters, digits and dashes."
        initialName="my-files"
        confirmLabel="Create"
        onOpenChange={setNewBucketOpen}
        onSubmit={async (name) => {
          const created = await filesApi(environmentId).cloudCreateBucket({ name });
          await queryClient.invalidateQueries({
            queryKey: filesQueryKeys.cloudState(environmentId),
          });
          onNavigate(created.id, "");
        }}
      />
      {home.data ? (
        <MoveDialog
          open={copyTarget !== null}
          environmentId={environmentId}
          rootPath={home.data.rootPath}
          startPath={home.data.rootPath}
          entries={[]}
          title={`Copy “${copyTarget?.name ?? ""}” to this computer`}
          description="Pick the folder to put it in. Anything with the same name is kept."
          confirmLabel="Copy here"
          onOpenChange={(open) => !open && setCopyTarget(null)}
          onMove={async (destination) => {
            if (!copyTarget || bucketId === null) return;
            setBusy(true);
            try {
              const result = await filesApi(environmentId).cloudCopyToComputer({
                bucketId,
                keys: [copyTarget.key],
                destinationPath: destination,
              });
              toastManager.add({
                type: "success",
                title: `Copied ${result.files} ${result.files === 1 ? "file" : "files"} to this computer`,
                description: formatFileSize(result.bytes),
              });
              await queryClient.invalidateQueries({ queryKey: ["files", "list"] });
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}” from Cloud storage?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isFolder
                ? "Everything inside this folder is deleted. This can't be undone."
                : "This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (!target || bucketId === null) return;
                try {
                  await filesApi(environmentId).cloudDelete({ bucketId, key: target.key });
                  toastManager.add({ type: "success", title: `Deleted “${target.name}”` });
                } catch (error) {
                  toastManager.add({
                    type: "error",
                    title: "Couldn't delete",
                    description: errorText(error),
                  });
                }
                refresh();
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function CloudEmpty({
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
      <div className="flex size-14 items-center justify-center rounded-2xl bg-sky-500/10">
        <CloudIcon className="size-7 text-sky-500" />
      </div>
      <div className="text-base font-medium">{title}</div>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}
