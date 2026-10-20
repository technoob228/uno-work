/**
 * "Add your own skill": a link, a dropped SKILL.md / folder / .zip, or the
 * laptop's skills folder (desktop app). Every way ends in the same preview
 * (SkillImportDialog): what's inside, where it's from, where it goes.
 */
import type { EnvironmentId, SkillsStageResult } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CopyIcon,
  FileUpIcon,
  FolderUpIcon,
  LaptopIcon,
  LinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";

import {
  pickFilesForProjectUpload,
  pickFolderForProjectUpload,
  readDroppedUploadFiles,
} from "../../projectUploadPickers";
import type { ProjectUploadFile } from "../../projectUpload";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  canImportFromLaptop,
  LAPTOP_SKILLS_PLACES,
  MAC_ZIP_COMMAND,
  stageDropped,
  stageFromLaptop,
  stageLink,
} from "./skillImport";

type Busy = "link" | "files" | "laptop" | null;

export function SkillsAddOwn({
  environmentId,
  onStaged,
}: {
  environmentId: EnvironmentId | null;
  onStaged: (preview: SkillsStageResult) => void;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [where, setWhere] = useState(false);
  const laptop = canImportFromLaptop();

  const run = async (kind: Exclude<Busy, null>, stage: () => Promise<SkillsStageResult | null>) => {
    if (!environmentId) {
      setError("Couldn't reach this computer. Give it a moment and try again.");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const preview = await stage();
      if (preview) {
        onStaged(preview);
        if (kind === "link") setLink("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't read these skills.");
    } finally {
      setBusy(null);
    }
  };
  const fromFiles = (files: ProjectUploadFile[]) => {
    if (files.length === 0) return;
    void run("files", () => stageDropped(environmentId!, files));
  };

  return (
    <div
      className="mt-3 rounded-2xl border border-border px-4 py-4 sm:px-5"
      data-testid="setup-add-skill"
    >
      <div className="text-sm font-medium">Add your own skill</div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Input
          className="min-w-[200px] flex-1"
          placeholder="GitHub, skills.sh or .zip link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && link.trim())
              void run("link", () => stageLink(environmentId!, link));
          }}
          aria-label="Skill link"
          data-testid="setup-add-skill-link"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!link.trim() || busy !== null}
          onClick={() => void run("link", () => stageLink(environmentId!, link))}
        >
          {busy === "link" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <LinkIcon className="size-3.5" />
          )}
          Add
        </Button>
      </div>
      <div
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
          const transfer = event.dataTransfer;
          void readDroppedUploadFiles(transfer).then(fromFiles);
        }}
        className={cn(
          "mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-3 py-2.5 text-xs transition-colors",
          over ? "border-primary bg-primary/5" : "border-border",
        )}
        data-testid="setup-add-skill-drop"
      >
        {busy === "files" ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <FileUpIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 text-muted-foreground">
          {busy === "files" ? "Reading…" : "Drop a SKILL.md, a folder or a .zip"}
        </span>
        <span className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => pickFilesForProjectUpload(fromFiles)}
          >
            Choose file
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => pickFolderForProjectUpload(fromFiles)}
          >
            <FolderUpIcon className="size-3.5" />
            Folder
          </Button>
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <LaptopIcon className="hidden size-3.5 shrink-0 sm:block" />
        {laptop ? (
          <>
            <span>Skills on your laptop already?</span>
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run("laptop", () => stageFromLaptop(environmentId!))}
              data-testid="setup-add-skill-laptop"
            >
              {busy === "laptop" ? <Loader2Icon className="size-3 animate-spin" /> : null}
              Import from this computer
            </Button>
          </>
        ) : (
          <span>
            Skills on your laptop already? Zip <code className="font-mono">~/.claude/skills</code>{" "}
            and drop it here.
          </span>
        )}
        <button
          type="button"
          onClick={() => setWhere((value) => !value)}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
          aria-expanded={where}
        >
          Where are they?
          <ChevronRightIcon className={cn("size-3 transition-transform", where && "rotate-90")} />
        </button>
      </div>
      {where ? (
        <div
          className="mt-2 rounded-xl bg-muted/40 px-3 py-2.5 text-xs"
          data-testid="setup-add-skill-where"
        >
          <table className="w-full border-separate border-spacing-y-1">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="pr-3 font-normal" />
                <th className="pr-3 font-normal">Mac, Linux</th>
                <th className="font-normal">Windows</th>
              </tr>
            </thead>
            <tbody>
              {LAPTOP_SKILLS_PLACES.map((place) => (
                <tr key={place.agent}>
                  <td className="pr-3 align-top font-medium whitespace-nowrap">{place.agent}</td>
                  <td className="pr-3 align-top font-mono break-all">{place.mac}</td>
                  <td className="align-top font-mono break-all">{place.windows}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-1.5 text-muted-foreground">
            Hidden in Finder: press <kbd className="font-mono">⌘⇧.</kbd> to show them. Or zip in
            Terminal:
          </div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 font-mono">
              {MAC_ZIP_COMMAND}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy command"
              onClick={() => {
                void navigator.clipboard?.writeText(MAC_ZIP_COMMAND);
                toastManager.add({ type: "success", title: "Copied" });
              }}
            >
              <CopyIcon />
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          className="mt-2 text-xs text-destructive-foreground"
          role="alert"
          data-testid="setup-add-skill-error"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
