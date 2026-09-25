/**
 * Uno Drive — the person's cloud storage as an app ("Made by Uno").
 *
 * Files: the account's "drive" bucket in the Cloud storage browser (upload,
 * download, Office, folders), plus what a bucket alone doesn't have — search
 * over everything, recent files, share links that work while the computer
 * sleeps, and Telegram: send a file to the bot, it lands here.
 */
import type { FilesDriveFile } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ClockIcon,
  DownloadIcon,
  FolderOpenIcon,
  HardDriveIcon,
  LinkIcon,
  Loader2Icon,
  PencilIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { isOfficeFile } from "../office/officeFormats";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { CloudBrowser, CloudUsageBar, formatQuota } from "../files/CloudBrowser";
import { filesApi } from "../files/filesApi";
import { UploadPanel, useFilesUploads } from "../files/FilesUploads";
import {
  FILE_KIND_ICON,
  FILE_KIND_TINT,
  fileKindOf,
  formatFileSize,
  formatModified,
} from "../files/fileTypes";
import { DriveShareDialog } from "./DriveShareDialog";
import { DriveTelegramPanel } from "./DriveTelegramPanel";
import {
  driveFolderOf,
  driveRecentQueryOptions,
  driveQueryKeys,
  driveSearchQueryOptions,
  driveSharesQueryOptions,
  driveStateQueryOptions,
  type DriveTab,
} from "./driveApi";

const TABS: ReadonlyArray<{ id: DriveTab; label: string; icon: typeof HardDriveIcon }> = [
  { id: "files", label: "My files", icon: HardDriveIcon },
  { id: "recent", label: "Recent", icon: ClockIcon },
  { id: "links", label: "Shared links", icon: LinkIcon },
  { id: "telegram", label: "Telegram", icon: SendIcon },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function DriveView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const search = useSearch({ from: "/_chat/drive" });
  const navigate = useNavigate({ from: "/drive" });
  const queryClient = useQueryClient();
  const uploads = useFilesUploads(environmentId);
  const tab: DriveTab = search.tab ?? "files";
  const [query, setQuery] = useState("");
  const [smart, setSmart] = useState(false);
  const [shareTarget, setShareTarget] = useState<{ key: string; name: string } | null>(null);
  const [waiting, setWaiting] = useState(false);

  const state = useQuery({
    ...driveStateQueryOptions(environmentId),
    refetchInterval: waiting ? 3_000 : false,
  });
  const trimmed = query.trim();
  const results = useQuery(driveSearchQueryOptions(environmentId, trimmed));
  const smartResults = useQuery({
    queryKey: [...driveQueryKeys.search(environmentId, trimmed), "smart"],
    queryFn: () => filesApi(environmentId).driveSearch({ query: trimmed, smart: true }),
    enabled: smart && trimmed.length > 0 && environmentId !== null,
    staleTime: 60_000,
    retry: 0,
  });
  const recent = useQuery(driveRecentQueryOptions(environmentId, tab === "recent" && !trimmed));
  const shares = useQuery(driveSharesQueryOptions(environmentId, tab === "links" && !trimmed));
  const revoke = useMutation({
    mutationFn: (id: number) => filesApi(environmentId).driveShareRevoke({ id }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.shares(environmentId) }),
  });

  const bucketId = state.data?.bucketId ?? null;
  const setTab = (next: DriveTab) => {
    setQuery("");
    void navigate({ search: next === "files" ? {} : { tab: next } });
  };
  const openFolder = useCallback(
    (prefix: string) => {
      setQuery("");
      void navigate({ search: prefix ? { prefix } : {} });
    },
    [navigate],
  );

  const opensInOffice = (key: string) => !isElectron && isOfficeFile(key) && bucketId !== null;
  const openFile = async (file: FilesDriveFile) => {
    if (bucketId === null) return;
    if (opensInOffice(file.key)) {
      void navigate({ to: "/office", search: { bucket: bucketId, key: file.key } });
      return;
    }
    await download(file);
  };
  const download = async (file: { key: string }) => {
    if (bucketId === null) return;
    try {
      const { url } = await filesApi(environmentId).cloudDownloadUrl({ bucketId, key: file.key });
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
    <header className="shrink-0 border-b border-border px-3 pt-2 sm:px-5 sm:pt-3">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 text-white">
          <HardDriveIcon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Uno Drive</h1>
          <p className="truncate text-xs text-muted-foreground">
            {state.data?.available
              ? `${formatQuota(state.data.usedBytes, state.data.quotaBytes)} · your Cloud storage, on every computer and in Telegram`
              : "Your Cloud storage"}
          </p>
        </div>
        <div className="ml-auto flex w-full max-w-xs items-center gap-1.5">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            placeholder="Search Uno Drive"
            aria-label="Search Uno Drive"
            value={query}
            disabled={!state.data?.available}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSmart(false);
            }}
          />
          {query ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>
      {state.data?.available && state.data.quotaBytes > 0 ? (
        <div className="mt-2 max-w-md">
          <CloudUsageBar used={state.data.usedBytes} quota={state.data.quotaBytes} />
        </div>
      ) : null}
      <nav className="-mb-px mt-2 flex gap-1 overflow-x-auto" aria-label="Uno Drive">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm transition-colors",
              tab === item.id && !trimmed
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
            {item.id === "telegram" && (state.data?.telegram.chats.length ?? 0) > 0 ? (
              <span className="size-1.5 rounded-full bg-emerald-500" aria-label="connected" />
            ) : null}
          </button>
        ))}
      </nav>
    </header>
  );

  const fileList = (files: ReadonlyArray<FilesDriveFile>, empty: React.ReactNode) =>
    files.length === 0 ? (
      empty
    ) : (
      <ul className="divide-y divide-border/60">
        {files.map((file) => {
          const kind = fileKindOf(file.name);
          const Icon = FILE_KIND_ICON[kind];
          const folder = driveFolderOf(file.key);
          return (
            <li
              key={file.key}
              className="group flex items-center gap-3 px-3 py-2 hover:bg-accent/40 sm:px-5"
            >
              <button
                type="button"
                onClick={() => void openFile(file)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                  <Icon className={cn("size-4.5", FILE_KIND_TINT[kind])} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium group-hover:underline">
                    {file.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {folder || "My files"} · {formatFileSize(file.size)}
                    {file.modifiedAt ? ` · ${formatModified(file.modifiedAt)}` : ""}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                {opensInOffice(file.key) ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Open ${file.name} in Office`}
                    onClick={() => void openFile(file)}
                  >
                    <PencilIcon />
                  </Button>
                ) : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Download ${file.name}`}
                  onClick={() => void download(file)}
                >
                  <DownloadIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Share ${file.name}`}
                  onClick={() => setShareTarget({ key: file.key, name: file.name })}
                >
                  <LinkIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Show ${file.name} in its folder`}
                  onClick={() => openFolder(folder)}
                >
                  <FolderOpenIcon />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );

  let body: React.ReactNode;
  if (state.isPending) {
    body = (
      <div className="flex flex-col gap-2 p-5">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (!state.data?.available || bucketId === null) {
    body = (
      <DriveEmpty
        title="Uno Drive isn't available here"
        detail={state.data?.message ?? errorText(state.error)}
      />
    );
  } else if (trimmed) {
    const smartFiles = smartResults.data?.files ?? [];
    body = results.isPending ? (
      <Busy text="Searching…" />
    ) : results.isError ? (
      <DriveEmpty title="Couldn't search" detail={errorText(results.error)} />
    ) : results.data.files.length > 0 ? (
      fileList(results.data.files, null)
    ) : smart ? (
      smartResults.isPending ? (
        <Busy text="Asking Uno AI…" />
      ) : smartFiles.length > 0 ? (
        <>
          <p className="px-5 pt-3 text-xs text-muted-foreground">
            Picked by Uno AI from your file names:
          </p>
          {fileList(smartFiles, null)}
        </>
      ) : (
        <DriveEmpty
          title={`Nothing found for “${trimmed}”`}
          detail={
            smartResults.error
              ? errorText(smartResults.error)
              : "Uno AI didn't find a match either."
          }
        />
      )
    ) : (
      <DriveEmpty
        title={`No file names with “${trimmed}”`}
        detail="Uno AI can guess from your file names — for example “contract with Ivan” or “last month's invoice”."
        action={
          <Button size="sm" variant="outline" onClick={() => setSmart(true)}>
            <SparklesIcon />
            Ask Uno AI
          </Button>
        }
      />
    );
  } else if (tab === "recent") {
    body = recent.isPending ? (
      <Busy text="Loading…" />
    ) : recent.isError ? (
      <DriveEmpty title="Couldn't load recent files" detail={errorText(recent.error)} />
    ) : (
      fileList(
        recent.data.files,
        <DriveEmpty
          title="No files yet"
          detail="Upload files here or send them to the Uno bot in Telegram."
        />,
      )
    );
  } else if (tab === "links") {
    const list = shares.data?.shares ?? [];
    body = shares.isPending ? (
      <Busy text="Loading…" />
    ) : shares.isError ? (
      <DriveEmpty title="Couldn't load links" detail={errorText(shares.error)} />
    ) : list.length === 0 ? (
      <DriveEmpty
        title="No shared links"
        detail="Share a file to get a link anyone can download from — it works even while your computer is asleep."
      />
    ) : (
      <ul className="divide-y divide-border/60">
        {list.map((share) => (
          <li key={share.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-5">
            <LinkIcon className="size-4 shrink-0 text-sky-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{share.key}</span>
              <span className="block text-xs text-muted-foreground">
                {share.expiresAt
                  ? `Until ${new Date(share.expiresAt).toLocaleDateString()}`
                  : "No end date"}{" "}
                · {share.downloads} {share.downloads === 1 ? "open" : "opens"}
                {share.createdVia === "telegram"
                  ? " · from Telegram"
                  : share.createdVia === "agent"
                    ? " · made by an agent"
                    : ""}
              </span>
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(share.id)}
            >
              Turn off
            </Button>
          </li>
        ))}
        <li className="px-5 py-3 text-xs text-muted-foreground">
          A link is shown once, when it's made. To send it again, share the file again.
        </li>
      </ul>
    );
  } else if (tab === "telegram") {
    body = (
      <DriveTelegramPanel
        environmentId={environmentId}
        state={state.data}
        onWaitingChange={setWaiting}
      />
    );
  } else {
    body = (
      <CloudBrowser
        environmentId={environmentId}
        bucketId={bucketId}
        prefix={search.prefix ?? ""}
        uploads={uploads}
        embedded={{ rootLabel: "My files" }}
        onOpenComputer={() => void navigate({ to: "/files" })}
        onNavigate={(_bucket, prefix) => openFolder(prefix)}
        onShare={(object) => setShareTarget({ key: object.key, name: object.name })}
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
      </div>
      <UploadPanel batches={uploads.batches} onDismiss={uploads.dismiss} />
      <DriveShareDialog
        environmentId={environmentId}
        target={shareTarget}
        onOpenChange={(open) => {
          if (!open) setShareTarget(null);
        }}
      />
    </SidebarInset>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {text}
    </div>
  );
}

function DriveEmpty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string | null;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-14 text-center">
      <HardDriveIcon className="size-8 text-muted-foreground/60" />
      <div className="text-sm font-medium">{title}</div>
      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
