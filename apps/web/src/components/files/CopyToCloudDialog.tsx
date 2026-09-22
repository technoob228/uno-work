/**
 * "Copy to Cloud storage" from This computer: pick a bucket (and optionally a
 * folder in it); the computer streams the files straight to S3.
 */
import type { EnvironmentId, FilesEntry } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
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
import { toastManager } from "../ui/toast";
import { formatFileSize } from "./fileTypes";
import { cloudStateQueryOptions, filesApi } from "./filesApi";

export function CopyToCloudDialog({
  open,
  environmentId,
  entries,
  onOpenChange,
}: {
  open: boolean;
  environmentId: EnvironmentId | null;
  entries: ReadonlyArray<FilesEntry>;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const state = useQuery({ ...cloudStateQueryOptions(environmentId), enabled: open });
  const [bucketId, setBucketId] = useState<number | null>(null);
  const [folder, setFolder] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setFolder("");
    setError(null);
  }, [open]);
  useEffect(() => {
    if (open && bucketId === null && state.data?.buckets[0]) setBucketId(state.data.buckets[0].id);
  }, [bucketId, open, state.data]);

  const title =
    entries.length === 1
      ? `Copy “${entries[0]?.name}” to Cloud storage`
      : `Copy ${entries.length} items to Cloud storage`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A copy goes to your account's Cloud storage; the original stays on this computer. Hidden
            files (like .env) are never copied.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {state.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading buckets…
            </div>
          ) : !state.data?.available ? (
            <p className="text-sm text-destructive">
              {state.data?.message ?? "Cloud storage isn't available."}
            </p>
          ) : state.data.buckets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no buckets yet. Open Cloud storage in Files and create one first.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Bucket">
                {state.data.buckets.map((bucket) => (
                  <button
                    key={bucket.id}
                    type="button"
                    role="radio"
                    aria-checked={bucketId === bucket.id}
                    onClick={() => setBucketId(bucket.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm",
                      bucketId === bucket.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <CloudIcon className="size-4 text-sky-500" />
                    <span className="min-w-0 flex-1 truncate">{bucket.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatFileSize(bucket.usedBytes)}
                    </span>
                  </button>
                ))}
              </div>
              <Input
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                placeholder="Folder in the bucket (optional)"
                aria-label="Folder in the bucket"
              />
            </>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || bucketId === null || !state.data?.available}
            onClick={async () => {
              if (bucketId === null) return;
              setPending(true);
              setError(null);
              try {
                const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
                const result = await filesApi(environmentId).cloudCopyToCloud({
                  paths: entries.map((entry) => entry.path),
                  bucketId,
                  ...(trimmed ? { prefix: `${trimmed}/` } : {}),
                });
                toastManager.add({
                  type: result.skipped.length > 0 ? "warning" : "success",
                  title: `Copied ${result.files} ${result.files === 1 ? "file" : "files"} to Cloud storage`,
                  description:
                    result.skipped.length > 0
                      ? `Left out: ${result.skipped.map((item) => `${item.name} (${item.reason})`).join(", ")}`
                      : formatFileSize(result.bytes),
                });
                await queryClient.invalidateQueries({ queryKey: ["files", "cloud"] });
                onOpenChange(false);
              } catch (copyError) {
                setError(copyError instanceof Error ? copyError.message : String(copyError));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : <CloudIcon />}
            Copy
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
