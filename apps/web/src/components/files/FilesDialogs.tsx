/**
 * Small dialogs of the Files app: name something (new folder, new document,
 * rename), confirm a delete, and pick a folder to move things into.
 */
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, FolderIcon, HomeIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { breadcrumbs } from "./fileTypes";
import { filesListQueryOptions } from "./filesApi";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function NameDialog({
  open,
  title,
  description,
  initialName,
  confirmLabel,
  selectBaseName = false,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description?: string;
  initialName: string;
  confirmLabel: string;
  /** Pre-select the name without its extension (rename). */
  selectBaseName?: boolean;
  onSubmit: (name: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setError(null);
    const timer = setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dot = initialName.lastIndexOf(".");
      input.setSelectionRange(0, selectBaseName && dot > 0 ? dot : initialName.length);
    }, 30);
    return () => clearTimeout(timer);
  }, [initialName, open, selectBaseName]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give it a name.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogPanel>
            <Input
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Name"
              aria-invalid={error ? true : undefined}
            />
            {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function DeleteDialog({
  open,
  entries,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  entries: ReadonlyArray<FilesEntry>;
  onConfirm: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const first = entries[0];
  const folders = entries.filter((entry) => entry.kind === "directory").length;
  const title =
    entries.length === 1 && first
      ? `Delete “${first.name}”?`
      : `Delete ${entries.length} items?`;
  const detail =
    folders > 0
      ? "Folders are deleted with everything inside them. This can't be undone, and any share links to them stop working."
      : "This can't be undone, and any share links to it stop working.";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{detail}</AlertDialogDescription>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (deleteError) {
                setError(errorText(deleteError));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function MoveDialog({
  open,
  environmentId,
  rootPath,
  startPath,
  entries,
  onMove,
  onOpenChange,
}: {
  open: boolean;
  environmentId: EnvironmentId | null;
  rootPath: string;
  startPath: string;
  entries: ReadonlyArray<FilesEntry>;
  onMove: (destination: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [path, setPath] = useState(startPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPath(startPath);
      setError(null);
    }
  }, [open, startPath]);
  const listing = useQuery({ ...filesListQueryOptions(environmentId, path, false), enabled: open });
  const moving = new Set(entries.map((entry) => entry.path));
  const folders = (listing.data?.entries ?? []).filter(
    (entry) => entry.kind === "directory" && !moving.has(entry.path),
  );
  const intoItself = entries.some(
    (entry) => entry.kind === "directory" && (path === entry.path || path.startsWith(`${entry.path}/`)),
  );
  const alreadyThere = entries.every((entry) => entry.path.slice(0, entry.path.lastIndexOf("/")) === path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Move {entries.length === 1 ? `“${entries[0]?.name}”` : `${entries.length} items`}
          </DialogTitle>
          <DialogDescription>Pick the folder to move into.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          <nav className="flex flex-wrap items-center gap-0.5 text-sm" aria-label="Folder">
            {breadcrumbs(rootPath, path).map((crumb, index, all) => (
              <span key={crumb.path} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setPath(crumb.path)}
                  className={cn(
                    "rounded px-1.5 py-0.5 hover:bg-accent",
                    index === all.length - 1 ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {index === 0 ? <HomeIcon className="inline size-3.5 -translate-y-px" /> : crumb.label}
                </button>
                {index < all.length - 1 ? <ChevronRightIcon className="size-3 text-muted-foreground" /> : null}
              </span>
            ))}
          </nav>
          <div className="max-h-64 min-h-32 overflow-y-auto rounded-lg border border-border">
            {listing.isPending ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading…
              </div>
            ) : folders.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                No folders inside.
              </div>
            ) : (
              folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  onClick={() => setPath(folder.path)}
                  className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                >
                  <FolderIcon className="size-4 text-sky-500" />
                  <span className="truncate">{folder.name}</span>
                  <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground" />
                </button>
              ))
            )}
          </div>
          {intoItself ? (
            <p className="text-sm text-destructive">A folder can't be moved into itself.</p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || intoItself || alreadyThere}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onMove(path);
                onOpenChange(false);
              } catch (moveError) {
                setError(errorText(moveError));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            Move here
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
