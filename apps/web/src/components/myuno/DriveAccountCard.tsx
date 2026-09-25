/**
 * Uno Drive on My Uno, straight from the account (no computer needed) — what
 * web lite has instead of the Drive app: connect Telegram, upload a file
 * through a one-time page, the newest files with a share link each.
 * The full app shows a button into /drive instead.
 */
import type { FilesDriveFile } from "@t3tools/contracts";
import {
  describeDriveError,
  parseDriveFiles,
  parseDriveShare,
  parseDriveState,
} from "@t3tools/shared/unoDrive";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, HardDriveIcon, LinkIcon, SendIcon, UploadIcon } from "lucide-react";
import { useState } from "react";

import { accountRequest } from "../../account/unoAccount";
import { formatBytes } from "../../account/billingModel";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { GroupTitle, RowList } from "./rowsUi";

function str(value: unknown): string {
  return value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["url"] === "string"
    ? ((value as Record<string, unknown>)["url"] as string)
    : "";
}

export function DriveAccountCard() {
  const state = useQuery({
    queryKey: ["account", "drive", "state"],
    queryFn: async () => parseDriveState(await accountRequest("GET", "/api/v1/drive")),
    staleTime: 15_000,
    retry: 1,
  });
  const recent = useQuery({
    queryKey: ["account", "drive", "recent"],
    queryFn: async () =>
      parseDriveFiles(await accountRequest("GET", "/api/v1/drive/recent?limit=8")),
    enabled: state.data?.available === true,
    staleTime: 15_000,
  });
  const [shared, setShared] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: async (what: "telegram" | "upload") => {
      const raw =
        what === "telegram"
          ? await accountRequest("POST", "/api/v1/drive/telegram/link", {})
          : await accountRequest("POST", "/api/v1/drive/upload-link", {});
      return str(raw);
    },
    onSuccess: (url) => {
      setError(null);
      if (url) window.open(url, "_blank", "noopener");
    },
    onError: (cause) => setError(describeDriveError(cause)),
  });
  const share = useMutation({
    mutationFn: async (file: FilesDriveFile) =>
      parseDriveShare(await accountRequest("POST", "/api/v1/drive/shares", { key: file.key })),
    onSuccess: (result) => {
      setError(null);
      if (result.url) setShared((previous) => ({ ...previous, [result.key]: result.url! }));
    },
    onError: (cause) => setError(describeDriveError(cause)),
  });
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url).catch(() => undefined);
    setCopied(url);
    window.setTimeout(() => setCopied(null), 1500);
  };

  if (state.isPending) return <Skeleton className="h-24 w-full rounded-2xl" />;
  if (!state.data?.available) return null;
  const chats = state.data.telegram.chats.length;

  return (
    <div className="flex flex-col gap-2" data-testid="my-uno-drive">
      <GroupTitle>Uno Drive</GroupTitle>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 text-white">
          <HardDriveIcon className="size-4.5" />
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="block font-medium">Your files in Cloud storage</span>
          <span className="block text-xs text-muted-foreground">
            {chats > 0
              ? `Telegram connected — send files to @${state.data.telegram.sharedBot} and they land here.`
              : "Connect Telegram: send a file to the Uno bot and it lands here, with a link back."}
          </span>
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={open.isPending || !state.data.telegram.sharedBotReady}
          onClick={() => open.mutate("telegram")}
        >
          <SendIcon />
          {chats > 0 ? "Connect another chat" : "Connect Telegram"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={open.isPending}
          onClick={() => open.mutate("upload")}
        >
          <UploadIcon />
          Upload a file
        </Button>
      </div>
      {error ? <p className="px-1 text-sm text-destructive">{error}</p> : null}
      {recent.data && recent.data.length > 0 ? (
        <RowList>
          {recent.data.map((file) => {
            const url = shared[file.key];
            return (
              <li
                key={file.key}
                className="flex min-h-11 items-center gap-3 border-b border-border/50 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{file.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {url ??
                      `${file.key.includes("/") ? file.key.slice(0, file.key.lastIndexOf("/") + 1) : ""}${file.key.includes("/") ? " · " : ""}${formatBytes(file.size)}`}
                  </span>
                </span>
                {url ? (
                  <Button size="xs" variant="outline" onClick={() => void copy(url)}>
                    {copied === url ? <CheckIcon /> : <CopyIcon />}
                    {copied === url ? "Copied" : "Copy link"}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={share.isPending}
                    onClick={() => share.mutate(file)}
                  >
                    <LinkIcon />
                    Share
                  </Button>
                )}
              </li>
            );
          })}
        </RowList>
      ) : null}
    </div>
  );
}
