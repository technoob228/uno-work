/**
 * Uploads in the Files app: a queue of batches (a pick or a drop), each shown
 * in a small panel with progress and Cancel, like a desktop copy dialog.
 */
import type { EnvironmentId, FilesConflictPolicy } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  PROJECT_UPLOAD_SIZE_LIMIT_LABEL,
  type ProjectUploadFile,
} from "../../projectUpload";
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

/** How a batch ended. */
export type UploadOutcome<T> =
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" };

interface UploadWork<T> {
  readonly label: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly skipped?: number;
  readonly run: (
    signal: AbortSignal,
    onProgress: (progress: {
      readonly sentBytes: number;
      readonly completedFiles: number;
      readonly currentPath: string | null;
    }) => void,
  ) => Promise<T>;
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

  /** A batch in the panel, with progress and Cancel, after the ones before it. */
  const enqueue = useCallback(
    <T,>(work: UploadWork<T>): Promise<UploadOutcome<T>> => {
      const id = nextBatchId++;
      const controller = new AbortController();
      const batch: UploadBatch = {
        id,
        label: work.label,
        totalFiles: work.totalFiles,
        totalBytes: work.totalBytes,
        sentBytes: 0,
        completedFiles: 0,
        status: "uploading",
        error: null,
        skipped: work.skipped ?? 0,
        controller,
      };
      setBatches((previous) => [
        ...previous.filter((entry) => entry.status === "uploading"),
        batch,
      ]);

      let lastPaint = 0;
      // One batch at a time: chunks of one file must arrive in order anyway.
      const run = chain.current.then(async (): Promise<UploadOutcome<T>> => {
        if (controller.signal.aborted) return { status: "cancelled" };
        try {
          const value = await work.run(controller.signal, (progress) => {
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
          });
          update(id, {
            status: "done",
            sentBytes: batch.totalBytes,
            completedFiles: batch.totalFiles,
          });
          return { status: "done", value };
        } catch (error) {
          if (controller.signal.aborted) {
            update(id, { status: "cancelled", error: null });
            return { status: "cancelled" };
          }
          const message = error instanceof Error ? error.message : String(error);
          update(id, { status: "failed", error: message });
          return { status: "failed", error: message };
        } finally {
          void queryClient.invalidateQueries({ queryKey: filesQueryKeys.all });
        }
      });
      chain.current = run;
      return run;
    },
    [queryClient, update],
  );

  const start = useCallback(
    async (input: {
      readonly targetDir: string;
      readonly files: ReadonlyArray<ProjectUploadFile>;
      readonly onConflict?: FilesConflictPolicy;
      readonly label?: string;
    }): Promise<boolean> => {
      if (environmentId === null || input.files.length === 0) return false;
      const tooBig = input.files.filter((file) => file.size > PROJECT_UPLOAD_MAX_FILE_BYTES);
      const files = input.files.filter((file) => file.size <= PROJECT_UPLOAD_MAX_FILE_BYTES);
      if (files.length === 0) {
        setBatches((previous) => [
          ...previous.filter((entry) => entry.status === "uploading"),
          {
            id: nextBatchId++,
            label: input.label ?? `${tooBig.length} files`,
            totalFiles: 0,
            totalBytes: 0,
            sentBytes: 0,
            completedFiles: 0,
            status: "failed",
            error: `Files over ${PROJECT_UPLOAD_SIZE_LIMIT_LABEL} can't be uploaded from the browser.`,
            skipped: tooBig.length,
            controller: new AbortController(),
          },
        ]);
        return false;
      }
      const first = files[0]?.relativePath.split("/")[0] ?? "";
      const outcome = await enqueue({
        label:
          input.label ??
          (files.length === 1
            ? first
            : `${files.length} files${first.includes(".") ? "" : ` in ${first}`}`),
        totalFiles: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        skipped: tooBig.length,
        run: (signal, onProgress) =>
          uploadIntoFolder({
            environmentId,
            targetDir: input.targetDir,
            files,
            onConflict: input.onConflict ?? "keepBoth",
            signal,
            onProgress,
          }),
      });
      return outcome.status === "done";
    },
    [enqueue, environmentId],
  );

  const dismiss = useCallback((id: number) => {
    setBatches((previous) => previous.filter((batch) => batch.id !== id));
  }, []);

  return { batches, start, enqueue, dismiss };
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
                      ? `Uploaded${batch.skipped > 0 ? ` · ${batch.skipped} over ${PROJECT_UPLOAD_SIZE_LIMIT_LABEL} skipped` : ""}`
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
