/**
 * "New project" — a small dialog with the ways a project starts (sidebar
 * New ▾ → New project, the command palette, empty states):
 *
 * - A folder on this computer: click through the home folder (recent folders
 *   first). No typed paths, nothing outside the home folder.
 * - Empty project: a new folder `~/<name>`.
 * - From GitHub: clone a repository into `~/<repo>`.
 *
 * Every path ends the same way: the folder becomes a project and a new chat
 * opens in it. ("From a template" is not offered: there are no project
 * templates yet.)
 */
import { isAssistantProjectId, type FilesystemBrowseEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  FolderIcon,
  FolderOpenIcon,
  HouseIcon,
  LockIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../../environmentApi";
import { GitHubIcon } from "../Icons";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { folderDisplayName, useFolderChats, useHomeFolderPath } from "../../hooks/useFolderChats";
import { cn } from "../../lib/utils";
import { type NewProjectStep, useNewProjectStore } from "../../navigation/newProjectStore";
import { selectProjectsForEnvironment, useStore } from "../../store";
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
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import {
  NEW_PROJECT_SOURCES,
  type NewProjectSource,
  checkNewFolderName,
  checkRepositoryInput,
  clampToHome,
  homeCrumbs,
  isInsideHome,
  isPickableFolder,
  recentHomeFolders,
  tildePath,
} from "./newProject.logic";

const SOURCE_COPY: Record<
  Exclude<NewProjectSource, "template">,
  { title: string; body: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  folder: {
    title: "A folder on this computer",
    body: "Something you already have in your home folder",
    Icon: FolderOpenIcon,
  },
  empty: {
    title: "Empty project",
    body: "A new folder in your home folder, named for you",
    Icon: PlusIcon,
  },
  github: {
    title: "From GitHub",
    body: "Clone one of your repositories",
    Icon: GitHubIcon,
  },
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function NewProjectDialog() {
  const open = useNewProjectStore((state) => state.open);
  const step = useNewProjectStore((state) => state.step);
  const setStep = useNewProjectStore((state) => state.setStep);
  const close = useNewProjectStore((state) => state.close);
  const { environmentId } = useActiveMachine();
  const home = useHomeFolderPath(environmentId);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-xl" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is a folder with its chats. Everything the agent makes stays in it.
          </DialogDescription>
        </DialogHeader>
        {step === "choose" ? (
          <DialogPanel>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {NEW_PROJECT_SOURCES.map((source) =>
                source === "template" ? null : (
                  <SourceCard
                    key={source}
                    source={source}
                    onClick={() => setStep(source as NewProjectStep)}
                  />
                ),
              )}
            </div>
          </DialogPanel>
        ) : environmentId === null || home === null ? (
          <DialogPanel>
            <BackToOptions onBack={() => setStep("choose")} />
            <p className="py-6 text-center text-sm text-muted-foreground">
              {environmentId === null
                ? "No computer is connected."
                : "Looking for your home folder…"}
            </p>
          </DialogPanel>
        ) : step === "folder" ? (
          <FolderStep
            environmentId={environmentId}
            home={home}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        ) : step === "empty" ? (
          <EmptyStep
            environmentId={environmentId}
            home={home}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        ) : (
          <GithubStep
            environmentId={environmentId}
            home={home}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SourceCard({
  source,
  onClick,
}: {
  source: Exclude<NewProjectSource, "template">;
  onClick: () => void;
}) {
  const { title, body, Icon } = SOURCE_COPY[source];
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`new-project-source-${source}`}
      className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border border-border/70 p-4 text-left outline-hidden transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs leading-snug text-muted-foreground">{body}</span>
    </button>
  );
}

function BackToOptions({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-2 inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeftIcon className="size-3.5" />
      All options
    </button>
  );
}

/** Names already used directly inside the home folder. */
function useHomeEntryNames(
  environmentId: NonNullable<ReturnType<typeof useActiveMachine>["environmentId"]>,
  home: string,
): ReadonlySet<string> | null {
  const listing = useQuery({
    queryKey: ["uno-computer", "browse-folder", environmentId, `${home}/`],
    queryFn: () =>
      ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath: `${home}/` }),
  });
  return useMemo(
    () => (listing.data ? new Set(listing.data.entries.map((entry) => entry.name)) : null),
    [listing.data],
  );
}

interface StepProps {
  readonly environmentId: NonNullable<ReturnType<typeof useActiveMachine>["environmentId"]>;
  readonly home: string;
  readonly onBack: () => void;
  readonly onDone: () => void;
}

function StepFooter(props: {
  error: string | null;
  busy: boolean;
  disabled: boolean;
  label: string;
  icon: ReactNode;
  onSubmit: () => void;
  onCancel: () => void;
  hint?: ReactNode;
}) {
  return (
    <>
      {props.error ? (
        <p className="px-6 pb-2 text-xs text-destructive" role="alert">
          {props.error}
        </p>
      ) : null}
      <DialogFooter className="items-center">
        {props.hint ? (
          <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
            {props.hint}
          </span>
        ) : null}
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          disabled={props.disabled || props.busy}
          onClick={props.onSubmit}
          data-testid="new-project-submit"
        >
          {props.busy ? <Spinner className="size-3.5" /> : props.icon}
          {props.label}
        </Button>
      </DialogFooter>
    </>
  );
}

function FolderStep({ environmentId, home, onBack, onDone }: StepProps) {
  const [folder, setFolder] = useState(home);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { chatInFolder } = useFolderChats(environmentId);
  const current = clampToHome(folder, home);
  const atHome = current === home;
  const projects = useStore(
    useShallow((store) =>
      selectProjectsForEnvironment(store, environmentId).filter(
        (project) => !isAssistantProjectId(project.id),
      ),
    ),
  );
  const projectCwds = useMemo(
    () => new Set(projects.map((project) => project.cwd.replace(/\/+$/, ""))),
    [projects],
  );
  const recents = useMemo(() => recentHomeFolders(projects, home), [projects, home]);

  const listing = useQuery({
    queryKey: ["uno-computer", "browse-folder", environmentId, `${current}/`],
    queryFn: () =>
      ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath: `${current}/` }),
  });
  const folders = (listing.data?.entries ?? []).filter(
    (entry: FilesystemBrowseEntry) =>
      entry.kind === "directory" &&
      isPickableFolder(entry.name, current, home) &&
      isInsideHome(entry.fullPath, home),
  );

  const submit = async () => {
    if (atHome) return;
    setBusy(true);
    setError(null);
    try {
      await chatInFolder(current);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't make this folder a project."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel className="flex flex-col gap-2">
        <BackToOptions onBack={onBack} />
        <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs">
          {homeCrumbs(current, home).map((crumb, index, all) => (
            <span key={crumb.path} className="flex items-center gap-0.5">
              {index > 0 ? <ChevronRightIcon className="size-3 text-muted-foreground/60" /> : null}
              <button
                type="button"
                onClick={() => setFolder(crumb.path)}
                disabled={index === all.length - 1}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent",
                  index === all.length - 1 ? "font-semibold" : "text-muted-foreground",
                )}
              >
                {index === 0 ? <HouseIcon className="size-3" /> : null}
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div
          className="h-64 overflow-y-auto rounded-xl border border-border/60 bg-background/60 p-1"
          data-testid="new-project-folder-list"
        >
          {atHome && recents.length > 0 ? (
            <>
              <p className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                Recent
              </p>
              <ul className="flex flex-col">
                {recents.map((project) => (
                  <FolderRow
                    key={`recent:${project.id}`}
                    name={tildePath(project.cwd, home)}
                    isProject
                    onClick={() => setFolder(project.cwd)}
                  />
                ))}
              </ul>
              <p className="px-2.5 pt-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                Home folder
              </p>
            </>
          ) : null}
          {listing.isPending ? (
            <div className="flex flex-col gap-1.5 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-7 w-full rounded-lg" />
              ))}
            </div>
          ) : listing.isError ? (
            <p className="p-3 text-xs text-destructive">
              {errorMessage(listing.error, "Can't open this folder.")}
            </p>
          ) : folders.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">No folders inside.</p>
          ) : (
            <ul className="flex flex-col">
              {folders.map((entry) => (
                <FolderRow
                  key={entry.fullPath}
                  name={entry.name}
                  isProject={projectCwds.has(entry.fullPath.replace(/\/+$/, ""))}
                  onClick={() => setFolder(entry.fullPath)}
                />
              ))}
            </ul>
          )}
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LockIcon className="size-3" />
          Only folders inside your home folder. System folders are hidden.
        </p>
      </DialogPanel>
      <StepFooter
        error={error}
        busy={busy}
        disabled={atHome || listing.isPending}
        label={atHome ? "Open a folder first" : `Make “${folderDisplayName(current)}” a project`}
        icon={<FolderIcon />}
        hint={tildePath(current, home)}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
    </>
  );
}

function FolderRow(props: { name: string; isProject: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent focus-visible:bg-accent"
        onClick={props.onClick}
      >
        <FolderIcon className="size-4 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate">{props.name}</span>
        {props.isProject ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <CodeIcon className="size-3" />
            project
          </span>
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
      </button>
    </li>
  );
}

function EmptyStep({ environmentId, home, onBack, onDone }: StepProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useHomeEntryNames(environmentId, home);
  const { chatInFolder } = useFolderChats(environmentId);
  const check = checkNewFolderName(name, taken ?? new Set());

  const submit = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await chatInFolder(`${home}/${check.name}`, check.name, { createFolder: true });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't create the project."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel className="flex flex-col gap-2">
        <BackToOptions onBack={onBack} />
        <label className="text-sm font-medium" htmlFor="new-project-name">
          Name
        </label>
        <Input
          id="new-project-name"
          autoFocus
          placeholder="my-project"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          {check.ok ? `Creates ${tildePath(`${home}/${check.name}`, home)}` : "Creates ~/<name>"}
        </p>
      </DialogPanel>
      <StepFooter
        error={error ?? (name.trim().length > 0 && !check.ok ? check.error : null)}
        busy={busy}
        disabled={!check.ok || taken === null}
        label="Create project"
        icon={<PlusIcon />}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
    </>
  );
}

function GithubStep({ environmentId, home, onBack, onDone }: StepProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useHomeEntryNames(environmentId, home);
  const { chatInFolder } = useFolderChats(environmentId);
  const check = checkRepositoryInput(input, taken ?? new Set());
  useEffect(() => setError(null), [input]);

  const submit = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const destinationPath = `${home}/${check.name}`;
      const result = await ensureEnvironmentApi(environmentId).sourceControl.cloneRepository({
        remoteUrl: check.remoteUrl,
        destinationPath,
      });
      await chatInFolder(result.cwd || destinationPath, check.name);
      onDone();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          "Couldn't clone the repository. For a private one, connect GitHub in Settings → Source control.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel className="flex flex-col gap-2">
        <BackToOptions onBack={onBack} />
        <label className="text-sm font-medium" htmlFor="new-project-repo">
          Repository
        </label>
        <Input
          id="new-project-repo"
          autoFocus
          placeholder="https://github.com/owner/repo or owner/repo"
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          {check.ok
            ? `Clones into ${tildePath(`${home}/${check.name}`, home)}`
            : "Clones into ~/<repo>"}
        </p>
      </DialogPanel>
      <StepFooter
        error={error ?? (input.trim().length > 0 && !check.ok ? check.error : null)}
        busy={busy}
        disabled={!check.ok || taken === null}
        label={busy ? "Cloning…" : "Clone and open"}
        icon={<GitHubIcon />}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
    </>
  );
}
