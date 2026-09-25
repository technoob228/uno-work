/**
 * Step 7 — material for the AI. Files go into `<project>/materials/` through
 * the Files upload (staged name, then renamed into place); links are kept in
 * `materials/links.md`. "Let AI read them" runs the daemon's reading job
 * (`/api/manager/materials/read`): every file and link is read in turn (the
 * rows go Ready → reading → Read), Uno AI writes what it learned — shown here
 * and saved as `materials/README.md` for every later chat — and the files are
 * copied to Cloud storage, where they stay safe while the computer sleeps.
 */
import {
  CheckIcon,
  FileTextIcon,
  ImageIcon,
  LinkIcon,
  Loader2Icon,
  PaperclipIcon,
  SheetIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { CloudIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
import {
  getMaterialsRead,
  startMaterialsRead,
  type MaterialReadItem,
  type MaterialReadJob,
} from "../../../lib/setupApi";
import { cn } from "../../../lib/utils";
import { formatUploadBytes } from "../../../projectUpload";
import { uploadIntoFolder } from "../../files/filesApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { tildePath } from "../setupModel";
import { SetupHeading, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress } from "../useSetupProgress";

interface MaterialRow {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  readonly kind: "file" | "link";
  readonly state: "uploading" | "saved" | "failed";
}

/** Icon by file type: sheets, pictures, everything else a document. */
export function materialIcon(row: {
  readonly name: string;
  readonly kind: "file" | "link";
}): LucideIcon {
  if (row.kind === "link") return LinkIcon;
  const ext = row.name.split(".").pop()?.toLowerCase() ?? "";
  if (/^(xlsx?|csv|tsv|ods|numbers)$/.test(ext)) return SheetIcon;
  if (/^(png|jpe?g|gif|webp|heic|svg|zip)$/.test(ext)) return ImageIcon;
  return FileTextIcon;
}

/** "5 files and 1 link". */
export function readCountLine(files: number, links: number): string {
  const f = `${files} file${files === 1 ? "" : "s"}`;
  if (links === 0) return f;
  const l = `${links} link${links === 1 ? "" : "s"}`;
  return files === 0 ? l : `${f} and ${l}`;
}

function jobItemFor(job: MaterialReadJob | null, row: MaterialRow): MaterialReadItem | undefined {
  return job?.items.find((item) => item.kind === row.kind && item.name === row.name);
}

export function MaterialsStep() {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const progress = useSetupProgress();
  const { completeStep } = useSetupNavigation();
  const [rows, setRows] = useState<ReadonlyArray<MaterialRow>>([]);
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<MaterialReadJob | null>(null);
  const [starting, setStarting] = useState(false);
  const root = progress.project?.path ?? home;
  const target = root ? `${root.replace(/\/+$/, "")}/materials` : null;
  const projectName = progress.project?.name ?? "Home folder";

  const setRow = (key: string, state: MaterialRow["state"]) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, state } : row)));
  // Anything new after a read needs another read.
  const invalidateRead = () => {
    setJobId(null);
    setJob(null);
  };

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (!environmentId || !target) {
      setError("Couldn't reach this computer. Give it a moment and try again.");
      return;
    }
    setError(null);
    invalidateRead();
    const files = [...list];
    const added = files.map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      detail: formatUploadBytes(file.size),
      kind: "file" as const,
      state: "uploading" as const,
    }));
    setRows((current) => [...current, ...added]);
    for (const [index, file] of files.entries()) {
      const row = added[index]!;
      try {
        await uploadIntoFolder({
          environmentId,
          targetDir: target,
          files: [{ relativePath: file.name, size: file.size, blob: file }],
          onConflict: "replace",
        });
        setRow(row.key, "saved");
      } catch (cause) {
        setRow(row.key, "failed");
        setError(cause instanceof Error ? cause.message : `Couldn't upload ${file.name}.`);
      }
    }
  };

  const addLink = async () => {
    const value = link.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) {
      setError("Paste a full address that starts with https://");
      return;
    }
    if (!environmentId || !target) return;
    invalidateRead();
    const key = `link-${Date.now()}`;
    setRows((current) => [
      ...current,
      { key, name: value, detail: "Link", kind: "link", state: "uploading" },
    ]);
    setLink("");
    setError(null);
    try {
      await ensureEnvironmentApi(environmentId).projects.writeFile({
        cwd: target,
        relativePath: "links.md",
        contents: `- ${value}\n`,
        encoding: "utf8",
        mode: "append",
      });
      setRow(key, "saved");
    } catch (cause) {
      setRow(key, "failed");
      setError(cause instanceof Error ? cause.message : "Couldn't save the link.");
    }
  };

  const remove = async (row: MaterialRow) => {
    invalidateRead();
    setRows((current) => current.filter((entry) => entry.key !== row.key));
    if (row.kind === "file" && environmentId && target && row.state === "saved") {
      await ensureEnvironmentApi(environmentId)
        .files.delete({ paths: [`${target}/${row.name}`] })
        .catch(() => undefined);
    }
  };

  const saved = rows.filter((row) => row.state === "saved");
  const busy = rows.some((row) => row.state === "uploading");
  const reading = jobId !== null && (job === null || job.state === "running");
  const read = job?.state === "done";

  const readAll = async () => {
    if (!environmentId || !root) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startMaterialsRead({
        environmentId,
        projectPath: root,
        links: saved.filter((row) => row.kind === "link").map((row) => row.name),
      });
      setJob(null);
      setJobId(started.jobId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start reading.");
    } finally {
      setStarting(false);
    }
  };

  // Follow the job twice a second until it's done.
  const jobRef = useRef(jobId);
  jobRef.current = jobId;
  useEffect(() => {
    if (!jobId || !environmentId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await getMaterialsRead({ environmentId, jobId });
        if (stopped || jobRef.current !== jobId) return;
        setJob(next);
        if (next.state === "running") window.setTimeout(() => void tick(), 500);
        else if (next.state === "failed") setError(next.error ?? "Couldn't read the material.");
      } catch (cause) {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "Couldn't read the material.");
        setJobId(null);
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [environmentId, jobId]);

  const readFiles =
    job?.items.filter((item) => item.kind === "file" && item.state === "read") ?? [];
  const readLinks =
    job?.items.filter((item) => item.kind === "link" && item.state === "read") ?? [];

  return (
    <SetupShell
      step="materials"
      primary={{
        label: "Continue",
        onClick: () => void completeStep("materials"),
        pending: busy,
      }}
    >
      <SetupHeading
        title="Give it your material"
        lead="Drop in what you already have: briefs, spreadsheets, photos, old texts. The more it sees, the less you explain."
      />
      <label
        htmlFor="setup-materials-input"
        onDragEnter={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void upload(event.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-colors",
          over ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30",
        )}
        data-testid="setup-dropzone"
      >
        <span className="mb-1 flex size-11 items-center justify-center rounded-xl border border-border bg-background text-primary">
          <UploadIcon className="size-5" />
        </span>
        <span className="font-medium">Drop files here</span>
        <span className="text-sm text-muted-foreground">or click to choose · any type</span>
        <span className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm">
          <PaperclipIcon className="size-3.5" />
          Choose files
        </span>
      </label>
      <input
        id="setup-materials-input"
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Input
          className="min-w-[220px] flex-1 font-mono"
          placeholder="https://your-site.com or a Google Doc link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addLink();
          }}
          aria-label="Link"
          data-testid="setup-materials-link"
        />
        <Button variant="outline" size="sm" onClick={() => void addLink()} disabled={!link.trim()}>
          <LinkIcon className="size-3.5" />
          Add link
        </Button>
      </div>
      {rows.length > 0 ? (
        <div
          className="mt-4 overflow-hidden rounded-2xl border border-border"
          data-testid="setup-materials-list"
        >
          {rows.map((row, index) => {
            const Icon = materialIcon(row);
            const item = jobItemFor(job, row);
            const itemState = item?.state ?? (reading && row.state === "saved" ? "queued" : null);
            return (
              <div
                key={row.key}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 text-sm",
                  index > 0 && "border-t border-border",
                )}
                title={item?.note ?? undefined}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    row.kind === "link" && "font-mono text-xs",
                  )}
                >
                  {row.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{row.detail}</span>
                <span className="w-16 shrink-0 text-right text-xs">
                  {row.state === "uploading" || itemState === "reading" ? (
                    <Loader2Icon className="ml-auto size-3.5 animate-spin text-muted-foreground" />
                  ) : row.state === "failed" || itemState === "failed" ? (
                    <span className="text-destructive-foreground">Failed</span>
                  ) : itemState === "read" ? (
                    <span className="inline-flex items-center gap-1 text-success-foreground">
                      <CheckIcon className="size-3" />
                      Read
                    </span>
                  ) : itemState === "skipped" ? (
                    <span className="text-muted-foreground">Skipped</span>
                  ) : (
                    <span className="text-muted-foreground">Ready</span>
                  )}
                </span>
                {reading || read ? null : (
                  <button
                    type="button"
                    aria-label={`Remove ${row.name}`}
                    onClick={() => void remove(row)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {saved.length > 0 && !read ? (
        <div className="mt-3 flex items-center justify-end gap-3">
          {!reading && target ? (
            <span className="mr-auto text-xs text-muted-foreground">
              In <span className="font-mono">{tildePath(target, home)}</span> on this computer
            </span>
          ) : null}
          <Button
            onClick={() => void readAll()}
            disabled={busy || reading || starting}
            data-testid="setup-materials-read"
          >
            {reading || starting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            {reading || starting ? "Reading" : "Let AI read them"}
          </Button>
        </div>
      ) : null}
      {read && job ? (
        <div
          className="mt-4 rounded-2xl border border-border bg-muted/20 p-4 text-sm"
          data-testid="setup-materials-learned"
        >
          <div className="flex items-center gap-2 font-medium">
            <CheckIcon className="size-4 text-success-foreground" />
            Your AI read {readCountLine(readFiles.length, readLinks.length)}
          </div>
          {job.learned.length > 0 ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-6 text-foreground/90">
              {job.learned.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : job.error ? (
            <p className="mt-2 text-muted-foreground">{job.error}</p>
          ) : null}
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CloudIcon className="size-3.5" />
            {job.savedToCloud
              ? `Saved to Cloud storage → ${job.savedToCloud}. Safe even when the computer sleeps.`
              : `Saved in ${projectName}/materials on this computer.`}
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-destructive-foreground">{error}</p> : null}
    </SetupShell>
  );
}
