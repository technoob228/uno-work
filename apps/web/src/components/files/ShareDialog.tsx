/**
 * "Share" — a public link to one file or folder, like "anyone with the link"
 * in Google Docs: optional expiry and password, list of live links with copy
 * and "Stop sharing". Web pages and folders can also be published to Uno
 * Hosting, which gives them their own address that stays up while the
 * computer sleeps. Plus "Shared links": every live link on this computer.
 */
import type { EnvironmentId, FilesEntry, FilesShare, FilesShareAccess } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  Loader2Icon,
  LockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { FILE_KIND_ICON, FILE_KIND_TINT, fileKindOf } from "./fileTypes";
import { filesApi, filesQueryKeys, filesSharesQueryOptions } from "./filesApi";
import { shareUrl, useShareBaseUrl, type ShareBase } from "./useShareBaseUrl";

/** Formats a link can edit in place (the engine writes them back as they are). */
const EDITABLE_BY_LINK = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);

export function canShareForEditing(name: string): boolean {
  return EDITABLE_BY_LINK.has(name.split(".").pop()?.toLowerCase() ?? "");
}

/**
 * "Can comment" is checked on the computer: a save through such a link may
 * only add comments. That check exists for Word documents so far.
 */
export function canShareForCommenting(name: string): boolean {
  return name.split(".").pop()?.toLowerCase() === "docx";
}

const ACCESS_OPTIONS: ReadonlyArray<{
  value: FilesShareAccess;
  label: string;
  hint: string;
}> = [
  { value: "view", label: "Can view", hint: "Opens in the browser, read-only." },
  { value: "comment", label: "Can comment", hint: "Can add comments, not change the text." },
  { value: "edit", label: "Can edit", hint: "Changes save into this file on your computer." },
];

const ACCESS_META: Record<FilesShareAccess, string | null> = {
  view: null,
  comment: "Can comment",
  edit: "Can edit",
};

const EXPIRY_OPTIONS = [
  { label: "Never", seconds: null },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toastManager.add({ type: "success", title: "Link copied" });
  } catch {
    toastManager.add({ type: "error", title: "Couldn't copy", description: text });
  }
}

function ShareRow({
  share,
  base,
  showName,
  onRevoke,
  revoking,
  onOpenItem,
}: {
  share: FilesShare;
  base: ShareBase;
  showName: boolean;
  onRevoke: () => void;
  revoking: boolean;
  onOpenItem?: () => void;
}) {
  const url = shareUrl(base, share.urlPath);
  const [copied, setCopied] = useState(false);
  const kind = share.kind === "folder" ? "folder" : fileKindOf(share.name);
  const Icon = FILE_KIND_ICON[kind];
  const meta = [
    ACCESS_META[share.access],
    share.expiresAt ? `Expires ${formatDate(share.expiresAt)}` : "No expiry",
    share.hasPassword ? "Password" : null,
    share.accessCount > 0
      ? `Opened ${share.accessCount} ${share.accessCount === 1 ? "time" : "times"}`
      : "Not opened yet",
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
      {showName ? (
        <button
          type="button"
          onClick={onOpenItem}
          className="flex min-w-0 items-center gap-2 text-left text-sm font-medium hover:underline"
        >
          <Icon className={cn("size-4 shrink-0", FILE_KIND_TINT[kind])} />
          <span className="truncate">{share.name}</span>
        </button>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
          {share.hasPassword ? (
            <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <LinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-xs text-foreground">{url ?? share.urlPath}</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!url}
          onClick={() => {
            if (!url) return;
            void copy(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          Copy
        </Button>
        {url ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Open link"
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {meta.join(" · ")}
        </span>
        <Button size="xs" variant="destructive-outline" disabled={revoking} onClick={onRevoke}>
          {revoking ? <Loader2Icon className="animate-spin" /> : null}
          Stop sharing
        </Button>
      </div>
    </div>
  );
}

function useRevokeShare(environmentId: EnvironmentId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => filesApi(environmentId).revokeShare({ id }),
    onSuccess: () => {
      toastManager.add({
        type: "success",
        title: "Link turned off",
        description: "It no longer opens.",
      });
      void queryClient.invalidateQueries({ queryKey: ["files", "shares"] });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't turn off the link",
        description: errorText(error),
      }),
  });
}

function AddressNote({ base }: { base: ShareBase }) {
  if (base.isPublic) return null;
  return (
    <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
      <span>
        {base.origin
          ? "This computer has no public address, so links only open on networks that can reach it. Links from an Uno computer work anywhere."
          : "This computer's public address isn't known yet, so links can't be copied from here. Open Files on the computer's own address to share."}
      </span>
    </div>
  );
}

function PublishSection({
  environmentId,
  entry,
}: {
  environmentId: EnvironmentId | null;
  entry: FilesEntry;
}) {
  const [slug, setSlug] = useState("");
  const publish = useMutation({
    mutationFn: () =>
      filesApi(environmentId).publishSite({
        path: entry.path,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
      }),
  });
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <GlobeIcon className="size-4 text-orange-500" />
        Publish as a website
      </div>
      <p className="text-xs text-muted-foreground">
        {entry.kind === "directory"
          ? "Puts this folder on Uno Hosting at its own address. It stays up even when this computer sleeps. The folder needs an index.html."
          : "Puts this page on Uno Hosting at its own address. It stays up even when this computer sleeps. Pictures or styles in other files aren't included — publish the folder for that."}
      </p>
      {publish.data ? (
        <div className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm">
          <CheckIcon className="size-4 text-success" />
          <a
            href={publish.data.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate font-medium hover:underline"
          >
            {publish.data.url}
          </a>
          <Button size="xs" variant="outline" onClick={() => void copy(publish.data.url)}>
            <CopyIcon />
            Copy
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input bg-background pr-2 text-sm">
            <Input
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
              placeholder="site-name (optional)"
              className="border-0 shadow-none"
              aria-label="Site name"
            />
            <span className="shrink-0 text-muted-foreground">.uno4.dev</span>
          </div>
          <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
            {publish.isPending ? <Loader2Icon className="animate-spin" /> : null}
            Publish
          </Button>
        </div>
      )}
      {publish.error ? (
        <p className="text-xs text-destructive">{errorText(publish.error)}</p>
      ) : null}
    </section>
  );
}

export function ShareDialog({
  open,
  environmentId,
  entry,
  onOpenChange,
}: {
  open: boolean;
  environmentId: EnvironmentId | null;
  entry: FilesEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const base = useShareBaseUrl(environmentId);
  const [expiry, setExpiry] = useState<number | null>(null);
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<FilesShareAccess>("view");
  useEffect(() => {
    if (open) {
      setAccess("view");
      setExpiry(null);
      setWithPassword(false);
      setPassword("");
    }
  }, [open]);

  const shares = useQuery({
    ...filesSharesQueryOptions(environmentId, entry?.path ?? null),
    enabled: open && entry !== null && environmentId !== null,
  });
  const editable = entry !== null && entry.kind !== "directory" && canShareForEditing(entry.name);
  const commentable = entry !== null && editable && canShareForCommenting(entry.name);
  const create = useMutation({
    mutationFn: () =>
      filesApi(environmentId).createShare({
        path: entry!.path,
        expiresInSeconds: expiry,
        password: withPassword ? password : null,
        ...(editable ? { access } : {}),
      }),
    onSuccess: (share) => {
      void queryClient.invalidateQueries({ queryKey: filesQueryKeys.shares(environmentId, null) });
      void queryClient.invalidateQueries({
        queryKey: filesQueryKeys.shares(environmentId, entry!.path),
      });
      setPassword("");
      setWithPassword(false);
      const url = shareUrl(base, share.urlPath);
      if (url) void copy(url);
    },
  });
  const revoke = useRevokeShare(environmentId);

  if (!entry) return null;
  const isFolder = entry.kind === "directory";
  const kind = fileKindOf(entry.name, isFolder);
  const Icon = FILE_KIND_ICON[kind];
  const canPublish = isFolder || kind === "html";
  const passwordTooShort = withPassword && password.length < 4;
  const liveShares = shares.data?.shares ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Icon className={cn("size-5 shrink-0", FILE_KIND_TINT[kind])} />
            <span className="truncate">Share “{entry.name}”</span>
          </DialogTitle>
          <DialogDescription>
            {isFolder
              ? "Anyone with the link can browse and download what's in this folder — nothing else on your computer. If the folder has an index.html, the link opens it as a website."
              : editable
                ? "Anyone with the link opens this file right in their browser — no Uno account needed. Choose whether they can only view it, comment, or edit. The link reaches this one file and nothing else on your computer."
                : "Anyone with the link can view and download this file — nothing else on your computer. They don't need an Uno account."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <AddressNote base={base} />
          {liveShares.length > 0 ? (
            <section className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                {liveShares.length === 1
                  ? "Link that works now"
                  : `${liveShares.length} links that work now`}
              </div>
              {liveShares.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  base={base}
                  showName={false}
                  revoking={revoke.isPending && revoke.variables === share.id}
                  onRevoke={() => revoke.mutate(share.id)}
                />
              ))}
            </section>
          ) : null}

          <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
            <div className="text-sm font-medium">
              {liveShares.length > 0 ? "Create another link" : "Create a link"}
            </div>
            {editable ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Anyone with the link</span>
                <div
                  className={cn("grid gap-1.5", commentable ? "grid-cols-3" : "grid-cols-2")}
                  role="radiogroup"
                  aria-label="What people with the link can do"
                >
                  {ACCESS_OPTIONS.filter((option) => option.value !== "comment" || commentable).map(
                    (option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={access === option.value}
                        data-testid={`share-access-${option.value}`}
                        onClick={() => setAccess(option.value)}
                        className={cn(
                          "flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                          access === option.value
                            ? "border-primary bg-primary/10"
                            : "border-border hover:bg-accent",
                        )}
                      >
                        <span className="text-sm font-medium text-foreground">{option.label}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {option.hint}
                        </span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Link stops working</span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Link expiry">
                {EXPIRY_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={expiry === option.seconds}
                    onClick={() => setExpiry(option.seconds)}
                    className={cn(
                      "h-7 rounded-full border px-3 text-xs transition-colors",
                      expiry === option.seconds
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {option.label === "Never" ? "Never" : `After ${option.label}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="files-share-password"
                  checked={withPassword}
                  onCheckedChange={(checked) => setWithPassword(checked === true)}
                />
                <Label htmlFor="files-share-password" className="text-sm">
                  Require a password
                </Label>
              </div>
              {withPassword ? (
                <Input
                  type="text"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 4 characters"
                  autoComplete="off"
                  aria-label="Link password"
                />
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                The link is copied as soon as it's made.
              </span>
              <Button
                onClick={() => create.mutate()}
                disabled={create.isPending || passwordTooShort}
              >
                {create.isPending ? <Loader2Icon className="animate-spin" /> : <LinkIcon />}
                Create link
              </Button>
            </div>
            {create.error ? (
              <p className="text-xs text-destructive">{errorText(create.error)}</p>
            ) : null}
          </section>

          {canPublish ? <PublishSection environmentId={environmentId} entry={entry} /> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function SharedLinksDialog({
  open,
  environmentId,
  onOpenItem,
  onOpenChange,
}: {
  open: boolean;
  environmentId: EnvironmentId | null;
  onOpenItem: (share: FilesShare) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const base = useShareBaseUrl(environmentId);
  const shares = useQuery({ ...filesSharesQueryOptions(environmentId, null), enabled: open });
  const revoke = useRevokeShare(environmentId);
  const list = shares.data?.shares ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Shared links</DialogTitle>
          <DialogDescription>
            Everything on this computer that opens from a link right now. Turn a link off and it
            stops working at once.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          <AddressNote base={base} />
          {shares.isPending ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              <Loader2Icon className="mr-2 size-4 animate-spin" />
              Loading…
            </div>
          ) : list.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              Nothing is shared. Use Share on a file or folder to make a link.
            </div>
          ) : (
            list.map((share) => (
              <ShareRow
                key={share.id}
                share={share}
                base={base}
                showName
                revoking={revoke.isPending && revoke.variables === share.id}
                onRevoke={() => revoke.mutate(share.id)}
                onOpenItem={() => {
                  onOpenChange(false);
                  onOpenItem(share);
                }}
              />
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
