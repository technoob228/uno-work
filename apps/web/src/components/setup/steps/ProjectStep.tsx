/**
 * Step 2 — the first project. The same thing as New → "Empty project": a
 * folder in the home folder that becomes a project (`project.create` with
 * `createWorkspaceRootIfMissing`), on the AI picked in step 1. "What kind of
 * work" shapes the questions, the skills on offer and the first tasks.
 *
 * Or "Import from my computer" (13.11): the Add computer window's flow inside
 * the page (`ImportFromComputer`); the first project brought becomes the
 * setup's project once it is copied, and the steps go on as usual.
 */
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3Icon,
  BotIcon,
  ChevronDownIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  GlobeIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useFolderChats, useHomeFolderPath } from "../../../hooks/useFolderChats";
import { cn } from "../../../lib/utils";
import { checkNewFolderName } from "../../newProject/newProject.logic";
import { Input } from "../../ui/input";
import { useSetupProjectPreview } from "../../sidebar/SidebarEmptyProjects";
import { BroughtProjectList, useBroughtRows } from "../BroughtProjects";
import { IMPORTED_PROJECT_KEY, type PickedProject } from "../devSetup";
import { withAnswer } from "../goals";
import { ImportFromComputer, useImportFromComputer } from "../ImportFromComputer";
import { SetupSpotlight } from "../SetupSpotlight";
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

const KIND_ICON: Readonly<Record<WorkKind, LucideIcon>> = {
  site: GlobeIcon,
  bot: BotIcon,
  data: BarChart3Icon,
  docs: FileTextIcon,
  other: SparklesIcon,
};

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

  // ── Import from my computer ──
  const [source, setSource] = useState<"new" | "import">("new");
  const importing = source === "import" && !existing;
  const flow = useImportFromComputer();
  /** What Bring started: the first one becomes the setup's project once it's here. */
  const [started, setStarted] = useState<{
    readonly computerId: string;
    readonly picks: ReadonlyArray<PickedProject>;
  } | null>(null);
  const { rows: broughtRows } = useBroughtRows(started?.computerId ?? null, started?.picks ?? []);
  const firstBrought = broughtRows[0] ?? null;
  const adopted = useRef(false);
  useEffect(() => {
    if (firstBrought?.state.kind !== "ready" || adopted.current) return;
    adopted.current = true;
    const { projectId, folder } = firstBrought.state;
    void (async () => {
      await update((current) =>
        withAnswer(
          {
            ...current,
            project: { id: projectId, path: folder, name: firstBrought.name, kind: "other" },
          },
          IMPORTED_PROJECT_KEY,
          projectId,
        ),
      );
      await completeStep("project");
    })();
  }, [completeStep, firstBrought, update]);
  const bring = async () => {
    const computerId = flow.computerId;
    if (computerId === null) return;
    const begun = await flow.choice.bring();
    if (!begun) return;
    if (begun.projects.length === 0) {
      setError("Pick a project to bring.");
      return;
    }
    adopted.current = false;
    setStarted({ computerId, picks: begun.projects });
  };
  const importPrimary =
    started !== null
      ? firstBrought?.state.kind === "failed"
        ? { label: "Pick again", onClick: () => setStarted(null) }
        : {
            label: `Copying ${firstBrought?.name ?? "it"}…`,
            onClick: () => undefined,
            pending: true,
          }
      : flow.phase === "bring"
        ? {
            label:
              flow.choice.pickedProjects.length === 0
                ? "Pick a project"
                : `Bring ${flow.choice.label}`,
            disabled: flow.choice.pickedProjects.length === 0,
            pending: flow.choice.busy,
            onClick: () => void bring(),
          }
        : null;

  // The sidebar shows the project where it will live while it's being named
  // (not while importing: the brought ones show up there themselves).
  const setPreview = useSetupProjectPreview((state) => state.setName);
  useEffect(() => {
    setPreview(existing || importing ? null : name);
  }, [existing, importing, name, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);

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
      primary={
        importing
          ? importPrimary
          : {
              label: existing ? "Continue" : "Create project",
              onClick: () => void create(),
              disabled: !existing && name.trim().length === 0,
              pending,
            }
      }
    >
      <SetupSpotlight selector='[data-testid="sidebar-new"]' />
      <SetupHeading
        title="Start your first project"
        lead="A project is a folder for one piece of work. Your AI sees only what’s inside it."
      />
      {existing ? null : (
        <div
          role="radiogroup"
          aria-label="New or imported"
          className="mb-6 inline-flex rounded-xl border border-border p-1"
          data-testid="setup-project-source"
        >
          {(
            [
              ["new", "New project"],
              ["import", "Import from my computer"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={source === id}
              onClick={() => {
                setSource(id);
                setError(null);
              }}
              data-testid={`setup-project-source-${id}`}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm transition-colors",
                source === id
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {importing ? (
        started !== null ? (
          <div className="flex max-w-xl flex-col gap-3" data-testid="setup-project-copying">
            <BroughtProjectList rows={broughtRows} shortPath={(path) => tildePath(path, home)} />
            <p className="text-xs text-muted-foreground">
              {broughtRows.length > 1
                ? `${firstBrought?.name} becomes this setup’s project; the others come along.`
                : "The next steps work in it once it’s here."}
            </p>
          </div>
        ) : (
          <ImportFromComputer flow={flow} page={false} />
        )
      ) : null}
      {error && importing ? (
        <p className="mt-3 text-sm text-destructive-foreground">{error}</p>
      ) : null}
      <div className={cn("grid gap-8 md:grid-cols-[1fr_280px]", importing && "hidden")}>
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
              {WORK_KINDS.map((entry) => {
                const Icon = KIND_ICON[entry.id];
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={kind === entry.id}
                    onClick={() => setKind(entry.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                      kind === entry.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-muted/60",
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </div>
        <aside className="flex flex-col gap-3 self-start rounded-2xl border border-dashed border-border p-4 text-sm">
          <div>
            <b className="font-medium">Where it lives</b>
            <p className="mt-0.5 text-muted-foreground">
              In the sidebar, under Chats. Every chat you start here stays in this project.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-background p-1.5">
            <div className="rounded-lg bg-primary/[0.07] px-2 py-1.5">
              <div className="flex items-center gap-2 text-sm">
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                <span className="flex size-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground uppercase">
                  {displayName[0]}
                </span>
                <span className="truncate font-medium">{displayName}</span>
              </div>
              <div className="mt-1 pl-[46px] text-xs text-muted-foreground">No chats yet</div>
            </div>
          </div>
          <p className="flex items-start gap-2 text-muted-foreground">
            <FolderPlusIcon className="mt-0.5 size-3.5 shrink-0" />
            Make another one any time with New → New project.
          </p>
        </aside>
      </div>
    </SetupShell>
  );
}
