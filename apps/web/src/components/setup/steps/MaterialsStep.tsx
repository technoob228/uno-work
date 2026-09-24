/**
 * Step 7 — material for the AI: files go into `<project>/materials/` through
 * the Files upload (staged name, then renamed into place); links are kept in
 * `materials/links.md`. The project folder is on this computer's disk, where
 * the agents can read them — cloud storage isn't reachable from a chat.
 */
import {
  CheckIcon,
  FileIcon,
  LinkIcon,
  Loader2Icon,
  PaperclipIcon,
  UploadIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
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

export function MaterialsStep() {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const progress = useSetupProgress();
  const { completeStep } = useSetupNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ReadonlyArray<MaterialRow>>([]);
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = progress.project?.path ?? home;
  const target = root ? `${root.replace(/\/+$/, "")}/materials` : null;

  const setRow = (key: string, state: MaterialRow["state"]) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, state } : row)));

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (!environmentId || !target) {
      setError("Couldn't reach this computer. Give it a moment and try again.");
      return;
    }
    setError(null);
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
          onConflict: "keepBoth",
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

  const saved = rows.filter((row) => row.state === "saved");
  const busy = rows.some((row) => row.state === "uploading");

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
          "flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          over ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30",
        )}
        data-testid="setup-dropzone"
      >
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
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
        ref={inputRef}
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
          {rows.map((row, index) => (
            <div
              key={row.key}
              className={cn(
                "flex items-center gap-3 px-4 py-2.5 text-sm",
                index > 0 && "border-t border-border",
              )}
            >
              {row.kind === "link" ? (
                <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
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
                {row.state === "uploading" ? (
                  <Loader2Icon className="ml-auto size-3.5 animate-spin text-muted-foreground" />
                ) : row.state === "saved" ? (
                  <span className="inline-flex items-center gap-1 text-success-foreground">
                    <CheckIcon className="size-3" />
                    Saved
                  </span>
                ) : (
                  <span className="text-destructive-foreground">Failed</span>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {saved.length > 0 && target ? (
        <p className="mt-3 text-xs text-muted-foreground">
          In <span className="font-mono">{tildePath(target, home)}</span> on this computer — your AI
          reads them when a task needs them.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-sm text-destructive-foreground">{error}</p> : null}
    </SetupShell>
  );
}
