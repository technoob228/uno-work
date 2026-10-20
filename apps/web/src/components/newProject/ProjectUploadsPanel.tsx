/**
 * A project upload outside the dialog: a small card in the corner of Work
 * ("Uploading luckyip · 38% · about 4 min left") that opens into the details,
 * Stop, Resume after a failure or a closed tab, and "luckyip is ready · Open".
 * The dialog shows the same progress (`UploadProgressDetails`) while it is open.
 */
import { CheckIcon, ChevronDownIcon, Loader2Icon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { formatUploadBytes } from "../../projectUpload";
import {
  dismissProjectUpload,
  openUploadedProject,
  restoreInterruptedUploads,
  resumeProjectUpload,
  setOpenUploadedProjectFallback,
  stopProjectUpload,
  useProjectUploads,
  type ProjectUploadJob,
} from "../../projectUploadJobs";
import {
  count,
  speedLine,
  timeLeftLine,
  uploadPercent,
  uploadRate,
} from "../../projectUploadSummary";
import { Button } from "../ui/button";

function jobRate(job: ProjectUploadJob) {
  return uploadRate(job.samples, { bytes: job.totalBytes, files: job.totalFiles });
}

/** "38% · about 4 min left" — the one line of the closed card. */
export function uploadShortLine(job: ProjectUploadJob): string {
  const percent = uploadPercent(job);
  const left = timeLeftLine(jobRate(job)?.secondsLeft ?? null);
  return left ? `${percent}% · ${left}` : `${percent}%`;
}

/** Bar by bytes, then bytes, files, speed and time left; the error if any. */
export function UploadProgressDetails({ job }: { job: ProjectUploadJob }) {
  const percent = uploadPercent(job);
  const rate = job.status === "uploading" ? jobRate(job) : null;
  const left = timeLeftLine(rate?.secondsLeft ?? null);
  return (
    <div className="flex flex-col gap-1" role="status" data-testid="project-upload-progress">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            job.status === "failed" ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs text-foreground tabular-nums">
        {percent}% · {formatUploadBytes(job.sentBytes)} of {formatUploadBytes(job.totalBytes)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {count(job.completedFiles)} of {count(job.totalFiles)} files
        {job.status === "uploading"
          ? rate
            ? ` · ${speedLine(rate.bytesPerSecond)}${left ? ` · ${left}` : ""}`
            : " · measuring speed…"
          : ""}
      </span>
      {job.error ? (
        <span
          className={cn(
            "text-xs",
            job.status === "uploading" ? "text-muted-foreground" : "text-destructive",
          )}
          role={job.status === "uploading" ? undefined : "alert"}
        >
          {job.error}
        </span>
      ) : null}
    </div>
  );
}

function statusLine(job: ProjectUploadJob): string {
  switch (job.status) {
    case "uploading":
      return uploadShortLine(job);
    case "done":
      return `In ${job.targetLabel}`;
    case "interrupted":
      return `Stopped when Work was closed · ${count(job.completedFiles)} of ${count(job.totalFiles)} files are there`;
    case "stopped":
      return `Stopped · ${count(job.completedFiles)} of ${count(job.totalFiles)} files are there`;
    case "failed":
      return job.error ?? "The upload stopped.";
  }
}

function titleLine(job: ProjectUploadJob): string {
  if (job.status === "uploading") return `Uploading ${job.name}`;
  if (job.status === "done") return `${job.name} is ready`;
  return `${job.name}: upload stopped`;
}

export function ProjectUploadsPanel() {
  const jobs = useProjectUploads((state) => state.jobs);
  const { handleNewThread } = useNewThreadHandler();
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void restoreInterruptedUploads();
  }, []);

  useEffect(() => {
    setOpenUploadedProjectFallback(async (projectRef) => {
      await handleNewThread(projectRef, { envMode: "local" });
    });
    return () => setOpenUploadedProjectFallback(null);
  }, [handleNewThread]);

  // Closing the tab stops the upload: the browser asks first. (Not in the
  // desktop app — there an unload guard would keep the window from closing;
  // the upload offers Resume when the app opens again.)
  const uploading = jobs.some((job) => job.status === "uploading");
  useEffect(() => {
    if (!uploading || isElectron) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [uploading]);

  const shown = jobs.filter((job) => !job.attached);
  if (shown.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-2"
      data-testid="project-uploads-panel"
    >
      {shown.map((job) => {
        const expanded = open === job.id;
        const percent = uploadPercent(job);
        return (
          <div
            key={job.id}
            className="pointer-events-auto rounded-xl border border-border bg-popover p-3 shadow-lg"
            data-testid="project-upload-card"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg",
                  job.status === "done"
                    ? "bg-success/15 text-success"
                    : job.status === "uploading"
                      ? "bg-primary/10 text-primary"
                      : "bg-destructive/15 text-destructive",
                )}
              >
                {job.status === "uploading" ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : job.status === "done" ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <UploadIcon className="size-3.5" />
                )}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => setOpen(expanded ? null : job.id)}
                aria-expanded={expanded}
              >
                <span className="flex items-center gap-1 text-sm font-medium">
                  <span className="truncate">{titleLine(job)}</span>
                  {job.status === "done" ? null : (
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                      )}
                    />
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground tabular-nums">
                  {statusLine(job)}
                </span>
              </button>
              {job.status === "done" ? (
                <Button size="xs" onClick={() => void openUploadedProject(job.id)}>
                  Open
                </Button>
              ) : job.status === "uploading" ? null : (
                <Button
                  size="xs"
                  onClick={() => void resumeProjectUpload(job.id)}
                  data-testid="project-upload-resume"
                >
                  Resume
                </Button>
              )}
              {job.status === "uploading" ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss"
                  title={
                    job.status === "done"
                      ? "Dismiss"
                      : "Dismiss — what's uploaded stays on the computer"
                  }
                  onClick={() => dismissProjectUpload(job.id)}
                >
                  <XIcon />
                </Button>
              )}
            </div>
            {job.status === "uploading" && !expanded ? (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
            ) : null}
            {expanded && job.status !== "done" ? (
              <div className="mt-2.5 flex flex-col gap-2.5">
                <UploadProgressDetails job={job} />
                <p className="text-[11px] text-muted-foreground">
                  Goes to {job.targetLabel}.{" "}
                  {job.status === "uploading"
                    ? "Keep Work open until it's done — you can use it as usual."
                    : job.status === "interrupted" && !job.hasHandle
                      ? "Resume asks you to pick the folder again; only the rest goes."
                      : "Resume sends only what's missing."}
                </p>
                {job.status === "uploading" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() => stopProjectUpload(job.id)}
                    data-testid="project-upload-stop"
                  >
                    Stop upload
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
