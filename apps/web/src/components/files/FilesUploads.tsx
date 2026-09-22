/**
 * Uploads in the Files app: a queue of batches (a pick or a drop), each shown
 * in a small panel with progress and Cancel, like a desktop copy dialog.
 */
import type { EnvironmentId, FilesConflictPolicy } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { PROJECT_UPLOAD_MAX_FILE_BYTES, type ProjectUploadFile } from "../../projectUpload";
import { Button } from "../ui/button";
import { formatFileSize } from "./fileTypes";
import { filesQueryKeys, uploadIntoFolder } from "./filesApi";

export interface UploadBatch {
  readonly id: number;
  readonly label: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  sentBytes: number;
  completedFiles: number;
  status: "uploading" | "done" | "failed" | "cancelled";
  error: string | null;
  skipped: number;
  controller: AbortController;
}

let nextBatchId = 1;

export function useFilesUploads(environmentId: EnvironmentId | null) {
  const queryClient = useQueryClient();
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const update = useCallback((id: number, patch: Partial<UploadBatch>) => {
    setBatches((previous) =>
      previous.map((batch) => (batch.id === id ? { ...batch, ...patch } : batch)),
    );
  }, []);

  const start = useCallback(
    (input: {
      readonly targetDir: string;
      readonly files: ReadonlyArray<ProjectUploadFile>;
      readonly onConflict?: FilesConflictPolicy;
      readonly label?: string;
    }): Promise<boolean> => {
      if (environmentId === null || input.files.length === 0) return Promise.resolve(false);
      const tooBig = input.files.filter((file) => file.size > PROJECT_UPLOAD_MAX_FILE_BYTES);
      const files = input.files.filter((file) => file.size <= PROJECT_UPLOAD_MAX_FILE_BYTES);
      const id = nextBatchId++;
      const controller = new AbortController();
      const first = files[0]?.relativePath.split("/")[0] ?? "";
      const batch: UploadBatch = {
        id,
        label:
          input.label ??
          (files.length === 1
            ? first
            : `${files.length} files${first.includes(".") ? "" : ` in ${first}`}`),
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        sentBytes: 0,
        completedFiles: 0,
        status: files.length === 0 ? "failed" : "uploading",
        error: files.length === 0 ? "Files over 1 GB can't be uploaded from the browser." : null,
        skipped: tooBig.length,
        controller,
      };
      setBatches((previous) => [
        ...previous.filter((entry) => entry.status === "uploading"),
        batch,
      ]);
      if (files.length === 0) return Promise.resolve(false);

      let lastPaint = 0;
      // One batch at a time: chunks of one file must arrive in order anyway.
      const run = chain.current.then(async () => {
        if (controller.signal.aborted) return false;
        try {
          await uploadIntoFolder({
            environmentId,
            targetDir: input.targetDir,
            files,
            onConflict: input.onConflict ?? "keepBoth",
            signal: controller.signal,
            onProgress: (progress) => {
              const now = Date.now();
              if (now - lastPaint < 150 && progress.currentPath !== null) return;
              lastPaint = now;
              update(id, {
                sentBytes: progress.sentBytes,
                completedFiles: progress.completedFiles,
              });
              if (progress.currentPath === null) {
                void queryClient.invalidateQueries({ queryKey: ["files", "list"] });
              }
            },
          });
          update(id, { status: "done", sentBytes: batch.totalBytes, completedFiles: files.length });
          return true;
        } catch (error) {
          const cancelled = controller.signal.aborted;
          update(id, {
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? null : error instanceof Error ? error.message : String(error),
          });
          return false;
        } finally {
          void queryClient.invalidateQueries({ queryKey: filesQueryKeys.all });
        }
      });
      chain.current = run;
      return run;
    },
    [environmentId, queryClient, update],
  );

  const dismiss = useCallback((id: number) => {
    setBatches((previous) => previous.filter((batch) => batch.id !== id));
  }, []);

  return { batches, start, dismiss };
}

export function UploadPanel({
  batches,
  onDismiss,
}: {
  batches: ReadonlyArray<UploadBatch>;
  onDismiss: (id: number) => void;
}) {
  if (batches.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-2">
      {batches.map((batch) => {
        const percent =
          batch.totalBytes > 0 ? Math.round((batch.sentBytes / batch.totalBytes) * 100) : 100;
        return (
          <div
            key={batch.id}
            className="pointer-events-auto rounded-xl border border-border bg-popover p-3 shadow-lg"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg",
                  batch.status === "done"
                    ? "bg-success/15 text-success"
                    : batch.status === "failed"
                      ? "bg-destructive/15 text-destructive"
                      : "bg-primary/10 text-primary",
                )}
              >
                {batch.status === "uploading" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : batch.status === "done" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <UploadIcon className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{batch.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {batch.status === "uploading"
                    ? `${formatFileSize(batch.sentBytes)} of ${formatFileSize(batch.totalBytes)}`
                    : batch.status === "done"
                      ? `Uploaded${batch.skipped > 0 ? ` · ${batch.skipped} over 1 GB skipped` : ""}`
                      : batch.status === "cancelled"
                        ? "Cancelled — nothing half-uploaded was kept"
                        : (batch.error ?? "Upload failed")}
                </div>
              </div>
              {batch.status === "uploading" ? (
                <Button size="xs" variant="ghost" onClick={() => batch.controller.abort()}>
                  Cancel
                </Button>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss"
                  onClick={() => onDismiss(batch.id)}
                >
                  <XIcon />
                </Button>
              )}
            </div>
            {batch.status === "uploading" ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
