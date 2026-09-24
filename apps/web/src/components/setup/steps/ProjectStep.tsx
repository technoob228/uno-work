/**
 * Step 2 — the first project. The same thing as New → "Empty project": a
 * folder in the home folder that becomes a project (`project.create` with
 * `createWorkspaceRootIfMissing`), on the AI picked in step 1. "What kind of
 * work" shapes the questions, the skills on offer and the first tasks.
 */
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, FolderIcon, FolderPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useFolderChats, useHomeFolderPath } from "../../../hooks/useFolderChats";
import { cn } from "../../../lib/utils";
import { checkNewFolderName } from "../../newProject/newProject.logic";
import { Input } from "../../ui/input";
import {
  WORK_KINDS,
  joinFolder,
  parseWorkKind,
  projectSlug,
  tildePath,
  type WorkKind,
} from "../setupModel";
import { SetupHeading, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress, useUpdateSetupProgress } from "../useSetupProgress";

function useDefaultModelSelection(): ModelSelection | null {
  const active = useComposerDraftStore((store) => store.stickyActiveProvider);
  const byProvider = useComposerDraftStore((store) => store.stickyModelSelectionByProvider);
  return active ? (byProvider[active] ?? null) : null;
}

/** Names already in the home folder (a new project folder must not clash). */
function useHomeEntryNames(
  environmentId: EnvironmentId | null,
  home: string | null,
): ReadonlySet<string> | null {
  const listing = useQuery({
    queryKey: ["uno-computer", "browse-folder", environmentId, `${home}/`],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).filesystem.browse({ partialPath: `${home}/` }),
    enabled: environmentId !== null && home !== null,
  });
  return useMemo(
    () => (listing.data ? new Set(listing.data.entries.map((entry) => entry.name)) : null),
    [listing.data],
  );
}

export function ProjectStep() {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const { completeStep } = useSetupNavigation();
  const { ensureFolderProject } = useFolderChats(environmentId);
  const defaultModel = useDefaultModelSelection();
  const existing = progress.project;

  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<WorkKind>(parseWorkKind(existing?.kind ?? "site"));
  const [customFolder, setCustomFolder] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = projectSlug(name);
  const folder = existing?.path ?? customFolder ?? (home ? joinFolder(home, slug) : `~/${slug}`);
  const taken = useHomeEntryNames(environmentId, home);
  const check = useMemo(
    () =>
      customFolder !== null || existing
        ? ({ ok: true } as const)
        : checkNewFolderName(slug, taken ?? new Set()),
    [customFolder, existing, slug, taken],
  );
  const displayName = name.trim() || "my-project";

  const create = async () => {
    if (existing) {
      await update((current) =>
        current.project ? { ...current, project: { ...current.project, kind } } : current,
      );
      await completeStep("project");
      return;
    }
    if (!name.trim()) {
      setError("Give the project a name.");
      return;
    }
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const ref = await ensureFolderProject(folder, displayName, {
        createFolder: true,
        defaultModelSelection: defaultModel,
      });
      await update((current) => ({
        ...current,
        project: { id: ref.projectId, path: folder, name: displayName, kind },
      }));
      await completeStep("project");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create the project.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SetupShell
      step="project"
      primary={{
        label: existing ? "Continue" : "Create project",
        onClick: () => void create(),
        disabled: !existing && name.trim().length === 0,
        pending,
      }}
    >
      <SetupHeading
        title="Start your first project"
        lead="A project is a folder for one piece of work. Your AI sees only what’s inside it."
      />
      <div className="grid gap-8 md:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-project-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="setup-project-name"
              value={name}
              placeholder="e.g. acme-landing"
              autoComplete="off"
              disabled={existing !== null}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Folder</span>
            {editingFolder && !existing ? (
              <Input
                className="font-mono"
                value={customFolder ?? folder}
                onChange={(event) => setCustomFolder(event.target.value)}
                aria-label="Folder on this computer"
                spellCheck={false}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {tildePath(folder, home)}
                </span>
                {!existing ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => {
                      setCustomFolder(folder);
                      setEditingFolder(true);
                    }}
                  >
                    Change
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">What kind of work?</span>
            <div role="radiogroup" aria-label="What kind of work" className="flex flex-wrap gap-2">
              {WORK_KINDS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={kind === entry.id}
                  onClick={() => setKind(entry.id)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-sm transition-colors",
                    kind === entry.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-muted/60",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </div>
        <aside className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/20 p-4 text-sm">
          <b className="font-medium">Where it lives</b>
          <p className="text-muted-foreground">
            In the sidebar, under Chats. Every chat you start here stays in this project.
          </p>
          <div className="rounded-xl border border-border bg-background p-2.5">
            <div className="flex items-center gap-2 text-sm">
              <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              <span className="flex size-5 items-center justify-center rounded bg-muted text-[10px] font-semibold uppercase">
                {displayName[0]}
              </span>
              <span className="truncate font-medium">{displayName}</span>
            </div>
            <div className="mt-1.5 pl-6 text-xs text-muted-foreground">No chats yet</div>
          </div>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <FolderPlusIcon className="mt-0.5 size-3.5 shrink-0" />
            Make another one any time with New → New project.
          </p>
        </aside>
      </div>
    </SetupShell>
  );
}
