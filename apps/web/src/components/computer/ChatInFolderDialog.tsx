/**
 * "Start a chat in a folder…" — pick a folder on this computer by clicking
 * through it (home first), and Uno opens a new chat there. A folder that is
 * already a project gets a new chat in that project; any other folder becomes
 * one. No paths to type.
 */
import type { EnvironmentId, FilesystemBrowseEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, FolderIcon, HomeIcon, MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";

function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return trimmed === "" || trimmed === "/" ? null : "/";
  return trimmed.slice(0, index);
}

export function ChatInFolderDialog({
  environmentId,
  open,
  onOpenChange,
  onStart,
}: {
  environmentId: EnvironmentId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (folder: string) => Promise<void>;
}) {
  /** null = home (`~`), resolved by the daemon. */
  const [folder, setFolder] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFolder(null);
      setError(null);
    }
  }, [open]);

  const listing = useQuery({
    queryKey: ["uno-computer", "browse-folder", environmentId, folder],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).filesystem.browse({
        partialPath: folder === null ? "~" : `${folder.replace(/\/+$/, "")}/`,
      }),
    enabled: open && environmentId !== null,
  });

  const current = listing.data?.parentPath ?? folder;
  useEffect(() => {
    if (folder === null && listing.data) setHome(listing.data.parentPath);
  }, [folder, listing.data]);

  const folders = (listing.data?.entries ?? []).filter(
    (entry: FilesystemBrowseEntry) => entry.kind === "directory" && !entry.name.startsWith("."),
  );
  const up = current ? parentOf(current) : null;
  const atHome = home !== null && current === home;
  const shown =
    current && home && current.startsWith(home) ? `~${current.slice(home.length)}` : current;

  const start = async () => {
    if (!current) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(current);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start the chat.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a chat in a folder</DialogTitle>
          <DialogDescription>
            Uno works with the files in the folder you pick. Open a folder, then start the chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex items-center gap-1.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Up one folder"
              disabled={!up || listing.isPending}
              onClick={() => up && setFolder(up)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Home folder"
              disabled={atHome || listing.isPending}
              onClick={() => setFolder(null)}
            >
              <HomeIcon />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={current ?? ""}>
              {shown ?? "~"}
            </span>
          </div>
          <div className="h-72 overflow-y-auto rounded-xl border border-border/60 bg-background/60 p-1">
            {listing.isPending ? (
              <div className="flex flex-col gap-1.5 p-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-7 w-full rounded-lg" />
                ))}
              </div>
            ) : listing.isError ? (
              <p className="p-3 text-xs text-destructive">
                {listing.error instanceof Error ? listing.error.message : "Can't open this folder."}
              </p>
            ) : folders.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No folders inside — start here.</p>
            ) : (
              <ul className="flex flex-col">
                {folders.map((entry) => (
                  <li key={entry.fullPath}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent focus-visible:bg-accent"
                      onClick={() => setFolder(entry.fullPath)}
                    >
                      <FolderIcon className="size-4 shrink-0 text-sky-500" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!current || starting || listing.isPending} onClick={() => void start()}>
            {starting ? <Spinner className="size-3.5" /> : <MessageSquarePlusIcon />}
            Chat in {current ? (current === home ? "home" : current.split("/").pop()) : "…"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
