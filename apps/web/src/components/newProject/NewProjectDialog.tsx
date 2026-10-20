/**
 * "New project" — a small dialog with the ways a project starts (sidebar
 * "+" → New project, the command palette, empty states):
 *
 * - Upload from my computer (first, 01.10): a folder or a .zip from the
 *   person's laptop goes to `~/projects/<name>` on the computer (zips are
 *   unpacked in the browser), with progress; then a chat opens in it. From
 *   the start screen the dropped files come in already and Uno gets a first
 *   task instead of an empty chat (store `files` / `afterCreate`).
 * - From Cloud storage (11.10): a folder of the account's cloud is copied to
 *   `~/projects/<name>`; the cloud copy stays where it is.
 * - From GitHub: clone a repository into `~/projects/<repo>`.
 * - Empty project: a new folder `~/projects/<name>`.
 * - A folder on this computer: click through the home folder (recent folders
 *   first). No typed paths, nothing outside the home folder.
 *
 * The dialog always says which computer the project goes to.
 *
 * Every path ends the same way: the folder becomes a project and a new chat
 * opens in it — unless the opener passed `afterCreate` (the start screen's
 * first task; a new chat's folder chip, which moves that chat there with what
 * was typed and words the dialog as "folder", never "project"). ("From a
 * template" is not offered: there are no project templates yet.)
 */
import {
  DEFAULT_RUNTIME_MODE,
  isAssistantProjectId,
  type FilesystemBrowseEntry,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudDownloadIcon,
  CloudIcon,
  CodeIcon,
  FileArchiveIcon,
  FilesIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderUpIcon,
  HouseIcon,
  LockIcon,
  MonitorIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import {
  PROJECT_UPLOAD_MAX_FILE_COUNT,
  formatUploadBytes,
  planProjectUpload,
  type ProjectUploadFile,
} from "../../projectUpload";
import {
  attachProjectUpload,
  openUploadedProject,
  resumeProjectUpload,
  startProjectUpload,
  stopProjectUpload,
  useProjectUploads,
  type ProjectUploadJob,
} from "../../projectUploadJobs";
import {
  chooseFolderForProjectUpload,
  pickFilesForProjectUpload,
  readDroppedFolder,
  type FileSystemDirectoryHandleLike,
  type ReadFolder,
} from "../../projectUploadPickers";
import {
  LEFT_OUT_LIST_FILE,
  count,
  findSkipSuggestions,
  leftOutHotspots,
  leftOutListText,
  skipFoldersFor,
  skippedGroupsLine,
  summarizeUploadPlan,
  uploadLimitLine,
  type SkipSuggestion,
  type SkipSuggestionId,
  type UploadPlanSummary,
} from "../../projectUploadSummary";
import { UploadProgressDetails } from "./ProjectUploadsPanel";
import { cloudListQueryOptions, cloudStateQueryOptions, filesApi } from "../files/filesApi";
import { isJunkPath, stripSharedTopFolder } from "../setup/goals";
import { expandZips } from "../setup/siteUpload";
import { GitHubIcon } from "../Icons";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { folderDisplayName, useFolderChats, useHomeFolderPath } from "../../hooks/useFolderChats";
import { cn } from "../../lib/utils";
import {
  type NewProjectStep,
  type NewProjectWording,
  useNewProjectStore,
} from "../../navigation/newProjectStore";
import { selectProjectsForEnvironment, useStore } from "../../store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Textarea } from "../ui/textarea";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import {
  type NewProjectSource,
  CLOUD_COPY_MAX_ITEMS,
  checkNewFolderName,
  describedProjectPrompt,
  type NewProjectContents,
  cloudCrumbs,
  cloudProjectName,
  freeProjectName,
  newProjectSources,
  projectsFolderPath,
  uploadProjectName,
  uploadedProjectPath,
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
  upload: {
    title: "Upload from my computer",
    body: "A folder, a .zip or a few files — or just tell Uno about it",
    Icon: FolderUpIcon,
  },
  folder: {
    title: "A folder on this computer",
    body: "Something you already have in your home folder",
    Icon: FolderOpenIcon,
  },
  cloud: {
    title: "From Cloud storage",
    body: "A folder you keep in your Uno cloud",
    Icon: CloudIcon,
  },
  empty: {
    title: "Empty project",
    body: "A new folder in ~/projects, named by you",
    Icon: PlusIcon,
  },
  github: {
    title: "From GitHub",
    body: "Paste a repository link, or pick one of yours",
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
  const wording = useNewProjectStore((state) => state.wording);
  const { environmentId } = useActiveMachine();
  const home = useHomeFolderPath(environmentId);
  const machineLabel = useMachineLabel(environmentId);
  const copy = dialogCopy(wording, step);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-xl" data-testid="new-project-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="new-project-machine"
          >
            <MonitorIcon className="size-3.5" />
            On computer <b className="font-medium text-foreground">{machineLabel}</b>
          </p>
        </DialogHeader>
        {step === "choose" ? (
          <DialogPanel>
            <div className="flex flex-col gap-2">
              {newProjectSources().map((source) =>
                source === "template" ? null : (
                  <SourceCard
                    key={source}
                    source={source}
                    primary={source === "upload"}
                    onClick={() => setStep(source as NewProjectStep)}
                  />
                ),
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground" data-testid="new-project-where">
              New folders go to <span className="font-mono text-foreground">~/projects</span> on
              this computer.
            </p>
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
        ) : step === "upload" ? (
          <UploadStep
            environmentId={environmentId}
            home={home}
            machineLabel={machineLabel}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        ) : step === "folder" ? (
          <FolderStep
            environmentId={environmentId}
            home={home}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        ) : step === "cloud" ? (
          <CloudStep
            environmentId={environmentId}
            home={home}
            machineLabel={machineLabel}
            onBack={() => setStep("choose")}
            onDone={close}
          />
        ) : step === "empty" ? (
          <EmptyStep
            environmentId={environmentId}
            home={home}
            wording={wording}
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

/** The dialog's title and line: "project" from the sidebar, "folder" from a chat's chip. */
function dialogCopy(
  wording: NewProjectWording,
  step: NewProjectStep,
): { title: string; description: string } {
  if (wording === "project") {
    return {
      title: "New project",
      description: "A project is a folder with its chats. Everything the agent makes stays in it.",
    };
  }
  const title =
    step === "empty"
      ? "New folder"
      : step === "upload"
        ? "Upload a folder"
        : step === "github"
          ? "Clone from GitHub"
          : "Add a folder";
  return { title, description: "Your chat will work in it. What you typed stays." };
}

/**
 * The last step of every path: the opener's `afterCreate` (the start screen's
 * first task, a chat's folder chip) — or, without one or when it fails, a new
 * chat in the folder.
 */
/** What the person told Uno about the project, and what its folder starts with. */
interface ProjectStory {
  readonly about: string;
  readonly contents: NewProjectContents;
}

function useFinishNewProject() {
  const afterCreate = useNewProjectStore((state) => state.afterCreate);
  const onCreated = useNewProjectStore((state) => state.onCreated);
  const { handleNewThread } = useNewThreadHandler();
  const { startTask } = useHomeLaunchers(useActiveMachine().environmentId);
  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      name: string,
      folder: string,
      story?: ProjectStory,
    ): Promise<void> => {
      try {
        onCreated?.({ name, folder, projectRef, ...story });
      } catch {
        // a listener's failure never blocks the project's chat
      }
      if (afterCreate) {
        const done = await afterCreate({ name, folder, projectRef, ...story }).then(
          () => true,
          () => false,
        );
        if (done) return;
      }
      // They told Uno about it: the project opens with their words as its first message.
      if (story && story.about.length > 0) {
        const sent = await startTask(describedProjectPrompt({ name, folder, ...story }), {
          folder,
          modelSelection: null,
          runtimeMode: DEFAULT_RUNTIME_MODE,
        }).then(
          () => true,
          () => false,
        );
        if (sent) return;
      }
      await handleNewThread(projectRef, { envMode: "local" });
    },
    [afterCreate, handleNewThread, onCreated, startTask],
  );
}

/** Names already used in `~/projects` (none yet when the folder isn't there). */
function useProjectsEntryNames(
  environmentId: NonNullable<ReturnType<typeof useActiveMachine>["environmentId"]>,
  home: string,
): ReadonlySet<string> | null {
  const partialPath = `${projectsFolderPath(home)}/`;
  const listing = useQuery({
    queryKey: ["uno-computer", "browse-folder", environmentId, partialPath],
    queryFn: () => ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath }),
    retry: false,
  });
  return useMemo(() => {
    if (listing.isError) return new Set<string>();
    return listing.data ? new Set(listing.data.entries.map((entry) => entry.name)) : null;
  }, [listing.data, listing.isError]);
}

function useMachineLabel(environmentId: ReturnType<typeof useActiveMachine>["environmentId"]) {
  const rows = useMachineRows();
  return rows.find((row) => row.environmentId === environmentId)?.label ?? "this computer";
}

function SourceCard({
  source,
  primary = false,
  onClick,
}: {
  source: Exclude<NewProjectSource, "template">;
  primary?: boolean;
  onClick: () => void;
}) {
  const { title, body, Icon } = SOURCE_COPY[source];
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`new-project-source-${source}`}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 text-left outline-hidden transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        primary ? "border-primary/40 bg-primary/[0.03]" : "border-border/70",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs leading-snug text-muted-foreground">{body}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

// ── Upload from my computer ──────────────────────────────────────────

interface PickedUpload {
  readonly files: ReadonlyArray<ProjectUploadFile>;
  readonly name: string;
  /** The picked folder's own name on the laptop (Resume checks a re-pick by it). */
  readonly sourceName: string;
  readonly fromZip: boolean;
  /** A folder or a zip names the project; loose files leave the name to the person. */
  readonly named: boolean;
  /** Heavy folders the reader skipped without opening them. */
  readonly unopenedFolders: ReadonlyArray<string>;
  /** The drop reader hit its own ceiling: the folder has more than we read. */
  readonly truncated: boolean;
  readonly handle: FileSystemDirectoryHandleLike | null;
  /** "Also skip" offers: vendor folders, git worktrees. */
  readonly suggestions: ReadonlyArray<SkipSuggestion>;
}

/**
 * A zip picked or dropped on its own is unpacked; a zip inside a folder is a
 * file of the project and stays as it is (before 20.10 it was unpacked into
 * the project's root, and the folder landed one level too deep).
 */
function isTopLevelZip(file: ProjectUploadFile): boolean {
  return /\.zip$/i.test(file.relativePath) && !file.relativePath.includes("/");
}

async function preparePicked(read: ReadFolder): Promise<PickedUpload> {
  const raw = read.files;
  const topZip = isTopLevelZip;
  const fromZip = raw.some(topZip);
  const name = uploadProjectName(raw);
  const named = (raw[0]?.relativePath.includes("/") ?? false) || (raw.length === 1 && fromZip);
  const sourceName = raw[0]?.relativePath.split("/")[0] ?? name;
  const expanded = fromZip
    ? [...raw.filter((file) => !topZip(file)), ...(await expandZips(raw.filter(topZip)))]
    : [...raw];
  const files = stripSharedTopFolder(expanded, (file, relativePath) => ({ ...file, relativePath }));
  // Looked for before the top folder comes off: that step also drops `.git`
  // paths, and a worktree is known by its `.git` file.
  const visible = expanded.filter((file) => !isJunkPath(file.relativePath));
  const top = visible[0]?.relativePath.split("/")[0] ?? "";
  const sharedTop = visible.every((file) => file.relativePath.startsWith(`${top}/`));
  const suggestions = (await findSkipSuggestions(expanded)).map((suggestion) => ({
    ...suggestion,
    folders: sharedTop
      ? suggestion.folders.map((folder) =>
          folder.startsWith(`${top}/`) ? folder.slice(top.length + 1) : folder,
        )
      : suggestion.folders,
  }));
  // `.git` paths come off with the top folder (above), never planned: still say so.
  const hadGit = expanded.some((file) => file.relativePath.split("/").includes(".git"));
  return {
    files,
    name,
    sourceName,
    fromZip,
    named,
    unopenedFolders:
      hadGit && !read.unopenedFolders.includes(".git")
        ? [...read.unopenedFolders, ".git"]
        : read.unopenedFolders,
    truncated: read.truncated,
    handle: read.handle ?? null,
    suggestions,
  };
}

/** Reading a folder: waiting for the browser (no count yet), or the live count. */
type ReadingState = { readonly found: number | null } | null;

function UploadStep({
  environmentId,
  home,
  machineLabel,
  onBack,
  onDone,
}: StepProps & { readonly machineLabel: string }) {
  const [picked, setPicked] = useState<PickedUpload | null>(null);
  const [reading, setReading] = useState<ReadingState>(null);
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useProjectUploads((state) => state.jobs.find((entry) => entry.id === jobId) ?? null);
  const [starting, setStarting] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<SkipSuggestionId> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const { ensureFolderProject } = useFolderChats(environmentId);
  const finish = useFinishNewProject();
  const wording = useNewProjectStore((state) => state.wording);
  const takeFiles = useNewProjectStore((state) => state.takeFiles);
  const takenOrNull = useProjectsEntryNames(environmentId, home);
  const taken = useMemo(() => takenOrNull ?? new Set<string>(), [takenOrNull]);
  // "I have a project" takes it any way it comes (Misha 11.10): a folder, a
  // zip, a few files, a GitHub link — or only a word about it, no folder at
  // all. The folder chip of a chat ("folder" wording) keeps the plain upload.
  const rich = wording === "project";
  const [repo, setRepo] = useState("");
  const [about, setAbout] = useState("");
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const aboutText = rich ? about.trim() : "";
  const fromRepo = rich && picked === null && repo.trim().length > 0;
  const aboutOnly = rich && picked === null && !fromRepo && aboutText.length > 0;
  const repoCheck = checkRepositoryInput(repo, taken);
  // Nothing names the project (loose files, or only a description): the person does.
  const needsName = (picked !== null && !picked.named) || aboutOnly;
  const suggestedName = freeProjectName(picked?.name ?? "my-project", taken);
  const nameCheck = checkNewFolderName(nameDraft ?? suggestedName, taken);
  const name = needsName
    ? nameCheck.ok
      ? nameCheck.name
      : null
    : picked
      ? freeProjectName(picked.name, taken)
      : fromRepo && repoCheck.ok
        ? repoCheck.name
        : null;
  const target = name ? uploadedProjectPath(home, name) : null;
  // "Also skip" is ticked by default only when the folder is over the limits
  // without it — otherwise everything that isn't rebuilt goes.
  const basePlan = useMemo(
    () => (picked ? planProjectUpload(picked.files, { filterIgnored: true }) : null),
    [picked],
  );
  const effectiveTicked = useMemo<ReadonlySet<SkipSuggestionId>>(() => {
    if (ticked) return ticked;
    if (!picked || !basePlan) return new Set();
    const over = basePlan.skipped.some((entry) => entry.reason === "over-budget");
    return new Set(over ? picked.suggestions.map((suggestion) => suggestion.id) : []);
  }, [ticked, picked, basePlan]);
  const skipFolders = useMemo(
    () => skipFoldersFor(picked?.suggestions ?? [], effectiveTicked),
    [picked, effectiveTicked],
  );
  const plan = useMemo(
    () =>
      picked
        ? skipFolders.size > 0
          ? planProjectUpload(picked.files, { filterIgnored: true, skipFolders })
          : basePlan
        : null,
    [picked, basePlan, skipFolders],
  );
  const summary = useMemo(
    () => (plan && picked ? summarizeUploadPlan(plan, picked.unopenedFolders) : null),
    [plan, picked],
  );
  const uploading = job !== null && job.status === "uploading";
  const busy = job !== null || working !== null || starting;

  // The dialog shows this upload; when it closes, the corner panel takes over.
  useEffect(() => {
    if (!jobId) return;
    attachProjectUpload(jobId, true);
    return () => attachProjectUpload(jobId, false);
  }, [jobId]);

  // Cancel while the browser is still reading: whatever it hands over later is dropped.
  const readToken = useRef(0);
  const cancelReading = () => {
    readToken.current += 1;
    setReading(null);
  };
  const accept = (read: ReadFolder | null) => {
    if (!read || read.files.length === 0) {
      setReading(null);
      if (read) setError("There are no files in it.");
      return;
    }
    setError(null);
    setReading((current) => current ?? { found: read.files.length });
    void preparePicked(read)
      .then((next) => {
        if (next.files.length === 0) {
          setError("There are no files in it.");
          return;
        }
        setTicked(null);
        setPicked(next);
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Couldn't read these files.")))
      .finally(() => setReading(null));
  };

  const chooseFolder = () => {
    setError(null);
    setReading(null);
    const token = ++readToken.current;
    const current = () => token === readToken.current;
    void chooseFolderForProjectUpload({
      onReading: (found) => {
        if (current()) setReading({ found });
      },
    })
      .then((read) => {
        if (current()) accept(read);
      })
      .catch((cause: unknown) => {
        if (!current()) return;
        setReading(null);
        setError(errorMessage(cause, "The browser didn't let us read this folder. Try again."));
      });
  };

  // Dropped on the start screen: the dialog opens with them.
  const dropped = useRef(false);
  useEffect(() => {
    if (dropped.current) return;
    dropped.current = true;
    const files = takeFiles();
    if (files) accept({ files: [...files], unopenedFolders: [], truncated: false });
  }, [takeFiles]);

  const submitWithoutUpload = async () => {
    if (!name || !target) return;
    setError(null);
    setWorking(fromRepo ? "Cloning…" : "Creating…");
    try {
      if (fromRepo && repoCheck.ok) {
        const result = await ensureEnvironmentApi(environmentId).sourceControl.cloneRepository({
          remoteUrl: repoCheck.remoteUrl,
          destinationPath: target,
        });
        const folder = result.cwd || target;
        await finish(await ensureFolderProject(folder, name), name, folder, {
          about: aboutText,
          contents: "repository",
        });
      } else {
        const projectRef = await ensureFolderProject(target, name, { createFolder: true });
        await finish(projectRef, name, target, { about: aboutText, contents: "none" });
      }
      onDone();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          fromRepo
            ? "Couldn't clone the repository. For a private one, connect GitHub in Settings → Source control."
            : "Couldn't create the project.",
        ),
      );
    } finally {
      setWorking(null);
    }
  };

  const submit = async () => {
    if (!picked) {
      await submitWithoutUpload();
      return;
    }
    if (!name || !target || !plan || !summary) return;
    setError(null);
    setStarting(true);
    try {
      const projectRef = await ensureFolderProject(target, name, { createFolder: true });
      const story = { about: aboutText, contents: "files" as const };
      const leftOut =
        summary.leftOut.length > 0 || summary.tooLarge.length > 0
          ? {
              fileName: LEFT_OUT_LIST_FILE,
              text: leftOutListText({ summary, folderName: picked.sourceName }),
            }
          : null;
      setJobId(
        startProjectUpload({
          environmentId,
          name,
          sourceName: picked.sourceName,
          target,
          targetLabel: tildePath(target, home),
          projectRef,
          files: picked.files,
          totalFiles: plan.accepted.length,
          totalBytes: plan.totalBytes,
          skipFolders,
          leftOut,
          handle: picked.handle,
          onFinished: async () => {
            await finish(projectRef, name, target, story);
            onDone();
          },
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't create the project."));
    } finally {
      setStarting(false);
    }
  };

  const overLimit = summary !== null && summary.leftOut.length > 0 && summary.leftOutBy !== null;

  return (
    <>
      <DialogPanel className="flex flex-col gap-3">
        {busy ? null : <BackToOptions onBack={onBack} />}
        {picked === null ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const token = ++readToken.current;
              const current = () => token === readToken.current;
              setReading({ found: 0 });
              void readDroppedFolder(event.dataTransfer, (found) => {
                if (current()) setReading({ found });
              }).then((read) => {
                if (current()) accept(read);
              });
            }}
            data-testid="new-project-upload-drop"
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            {reading ? (
              <div className="flex flex-col items-center gap-1.5" role="status">
                <Spinner className="size-6 text-muted-foreground" />
                <p className="text-sm font-medium tabular-nums" data-testid="new-project-reading">
                  {reading.found === null || reading.found === 0
                    ? "Reading the folder…"
                    : `Reading the folder… ${count(reading.found)} files found`}
                </p>
                <p className="max-w-80 text-xs text-muted-foreground">
                  {reading.found === null
                    ? "A big folder takes a few seconds. Then your browser asks to confirm the upload — click Upload."
                    : "node_modules, .git and other heavy folders aren't even opened."}
                </p>
                <Button size="xs" variant="ghost" onClick={cancelReading}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <FolderUpIcon className="size-7 text-muted-foreground" />
                <p className="text-sm">
                  {rich ? "Drop a folder, a .zip or files here" : "Drop a folder or a .zip here"}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={chooseFolder} data-testid="new-project-upload-folder">
                    <FolderOpenIcon className="size-4" />
                    Choose a folder…
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => zipInput.current?.click()}>
                    <FileArchiveIcon className="size-4" />
                    Choose a .zip…
                  </Button>
                  {rich ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        pickFilesForProjectUpload((files) =>
                          accept({ files, unopenedFolders: [], truncated: false }),
                        )
                      }
                      data-testid="new-project-upload-files"
                    >
                      <FilesIcon className="size-4" />
                      Choose files…
                    </Button>
                  ) : null}
                  <input
                    ref={zipInput}
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) {
                        accept({
                          files: [{ relativePath: file.name, size: file.size, blob: file }],
                          unopenedFolders: [],
                          truncated: false,
                        });
                      }
                    }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Up to {count(PROJECT_UPLOAD_MAX_FILE_COUNT)} files and 2 GB. node_modules, .git,
                  Python environments and build folders are skipped. Your browser asks to confirm —
                  that's expected.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-border p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sky-500/10 text-sky-600">
                {picked.fromZip ? (
                  <FileArchiveIcon className="size-4" />
                ) : (
                  <FolderIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {picked.named ? name : `${picked.files.length === 1 ? "1 file" : "Files"}`}
                </span>
                <span
                  className="block text-xs text-muted-foreground tabular-nums"
                  data-testid="new-project-upload-summary"
                >
                  {plan
                    ? `${count(plan.accepted.length)} files · ${formatUploadBytes(plan.totalBytes)}`
                    : null}
                </span>
              </span>
              {busy ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setPicked(null);
                    setNameDraft(null);
                    setTicked(null);
                  }}
                >
                  Change
                </Button>
              )}
            </div>
            {job ? (
              <UploadProgressDetails job={job} />
            ) : summary ? (
              <UploadPlanNotes
                summary={summary}
                suggestions={picked.suggestions}
                ticked={effectiveTicked}
                onTick={(id, on) => {
                  const next = new Set(effectiveTicked);
                  if (on) next.add(id);
                  else next.delete(id);
                  setTicked(next);
                }}
                truncated={picked.truncated}
              />
            ) : null}
          </div>
        )}
        {overLimit && !busy && summary ? (
          <OverLimitNotice
            summary={summary}
            onPickAnother={() => {
              setPicked(null);
              setTicked(null);
            }}
            onUseGithub={
              rich
                ? () => {
                    setPicked(null);
                    setTicked(null);
                    requestAnimationFrame(() =>
                      document.getElementById("new-project-upload-repo")?.focus(),
                    );
                  }
                : null
            }
          />
        ) : null}
        {rich && picked === null && !busy ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="new-project-upload-repo">
              Or a GitHub link
            </label>
            <Input
              id="new-project-upload-repo"
              placeholder="https://github.com/owner/repo or owner/repo"
              value={repo}
              onChange={(event) => {
                setRepo(event.currentTarget.value);
                setError(null);
              }}
              data-testid="new-project-upload-repo"
            />
          </div>
        ) : null}
        {rich && !busy ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="new-project-upload-about">
              Tell Uno about it{" "}
              <span className="font-normal text-muted-foreground">
                {picked === null && !fromRepo
                  ? "— enough on its own, no folder needed"
                  : "— optional"}
              </span>
            </label>
            <Textarea
              id="new-project-upload-about"
              rows={3}
              placeholder="What it is and what you want done. Uno reads this first."
              value={about}
              onChange={(event) => setAbout(event.currentTarget.value)}
              data-testid="new-project-upload-about"
            />
          </div>
        ) : null}
        {needsName && !busy ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="new-project-upload-name">
              Name
            </label>
            <Input
              id="new-project-upload-name"
              value={nameDraft ?? suggestedName}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              data-testid="new-project-upload-name"
            />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground" data-testid="new-project-destination">
          {job ? (uploading ? "Uploading to " : "Goes to ") : "Goes to "}
          <span className="font-mono text-foreground">
            {target ? tildePath(target, home) : "~/projects/<name>"}
          </span>{" "}
          on computer {machineLabel}.
          {uploading ? " You can close this window — the upload keeps going." : ""}
        </p>
      </DialogPanel>
      {job ? (
        <UploadJobFooter job={job} onHide={onDone} />
      ) : (
        <StepFooter
          error={
            error ??
            (fromRepo && !repoCheck.ok
              ? repoCheck.error
              : needsName && !nameCheck.ok
                ? nameCheck.error
                : null)
          }
          busy={busy}
          disabled={
            reading !== null ||
            name === null ||
            takenOrNull === null ||
            (picked !== null && (plan === null || plan.accepted.length === 0))
          }
          label={
            working ??
            (starting
              ? "Starting…"
              : fromRepo
                ? "Clone and open"
                : aboutOnly
                  ? "Create and open"
                  : overLimit && plan && summary
                    ? `Upload ${count(plan.accepted.length)} of ${count(summary.wantedFiles)} files`
                    : wording === "folder"
                      ? "Upload"
                      : "Upload and open")
          }
          icon={fromRepo ? <GitHubIcon /> : aboutOnly ? <PlusIcon /> : <FolderUpIcon />}
          onSubmit={() => void submit()}
          onCancel={onDone}
        />
      )}
    </>
  );
}

/** What stays behind and why — before the upload, so nothing is a surprise. */
function UploadPlanNotes({
  summary,
  suggestions,
  ticked,
  onTick,
  truncated,
}: {
  summary: UploadPlanSummary;
  suggestions: ReadonlyArray<SkipSuggestion>;
  ticked: ReadonlySet<SkipSuggestionId>;
  onTick: (id: SkipSuggestionId, on: boolean) => void;
  truncated: boolean;
}) {
  const automatic = summary.skippedGroups.filter(
    (group) => group.label !== "vendor" && group.label !== "git worktrees",
  );
  const automaticFiles = automatic.reduce((sum, group) => sum + (group.files ?? 0), 0);
  return (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      {automatic.length > 0 ? (
        <p data-testid="new-project-upload-skipped">
          Skipped: {skippedGroupsLine(automatic)}
          {automaticFiles > 0 ? ` (${count(automaticFiles)} files)` : ""} — the computer rebuilds
          these from the project.
        </p>
      ) : null}
      {summary.tooLarge.length > 0 ? (
        <p className="text-warning-foreground">
          {summary.tooLarge.length === 1
            ? `${summary.tooLarge[0]} is over 1 GB and stays on your computer.`
            : `${count(summary.tooLarge.length)} files over 1 GB stay on your computer.`}
        </p>
      ) : null}
      {truncated ? (
        <p className="text-warning-foreground">
          This folder is too big to read from a drop. Use Choose a folder… to read all of it.
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-1 pt-0.5" data-testid="new-project-upload-also-skip">
          <span className="font-medium text-foreground">Also skip</span>
          {suggestions.map((suggestion) => (
            <label key={suggestion.id} className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={ticked.has(suggestion.id)}
                onCheckedChange={(on) => onTick(suggestion.id, on === true)}
                className="mt-0.5"
                data-testid={`new-project-upload-skip-${suggestion.id}`}
              />
              <span>
                <span className="text-foreground">{suggestion.label}</span> — {suggestion.hint}
                <span className="block truncate" title={suggestion.folders.join("\n")}>
                  {suggestion.folders.slice(0, 2).join(", ")}
                  {suggestion.folders.length > 2
                    ? ` and ${suggestion.folders.length - 2} more`
                    : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Over the browser limits: say it before the upload, with the ways out. */
function OverLimitNotice({
  summary,
  onPickAnother,
  onUseGithub,
}: {
  summary: UploadPlanSummary;
  onPickAnother: () => void;
  onUseGithub: (() => void) | null;
}) {
  const hotspots = leftOutHotspots(summary.leftOut);
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/8 p-3 text-xs"
      role="alert"
      data-testid="new-project-upload-over-limit"
    >
      <p className="font-medium text-foreground">
        {count(summary.leftOut.length)} files won't fit. A browser upload takes{" "}
        {uploadLimitLine(summary.leftOutBy ?? "files")}, this folder has{" "}
        {count(summary.wantedFiles)}.
      </p>
      {hotspots.length > 0 ? (
        <p className="text-muted-foreground">
          Most of them are in{" "}
          {hotspots.map((spot) => `${spot.folder} (${count(spot.files)})`).join(", ")}.
        </p>
      ) : null}
      <p className="text-muted-foreground">
        Upload anyway and Uno gets the list of what's missing, in {LEFT_OUT_LIST_FILE}. Or pick a
        smaller folder{onUseGithub ? ", or paste a GitHub link — a clone has no limit" : ""}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={onPickAnother}>
          Choose another folder
        </Button>
        {onUseGithub ? (
          <Button size="xs" variant="outline" onClick={onUseGithub}>
            <GitHubIcon />
            Use a GitHub link
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** While uploading: Stop, and Hide (the upload keeps going); after: Resume. */
function UploadJobFooter({ job, onHide }: { job: ProjectUploadJob; onHide: () => void }) {
  return (
    <DialogFooter className="items-center">
      {job.status === "uploading" ? (
        <>
          <Button
            variant="outline"
            onClick={() => stopProjectUpload(job.id)}
            data-testid="new-project-upload-stop"
          >
            Stop upload
          </Button>
          <Button onClick={onHide} data-testid="new-project-upload-hide">
            Hide
          </Button>
        </>
      ) : job.status === "done" ? (
        <Button onClick={() => void openUploadedProject(job.id)}>Open</Button>
      ) : (
        <>
          <Button variant="outline" onClick={onHide}>
            Close
          </Button>
          <Button
            onClick={() => void resumeProjectUpload(job.id)}
            data-testid="new-project-upload-resume"
          >
            <FolderUpIcon />
            Resume
          </Button>
        </>
      )}
    </DialogFooter>
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
  const { ensureFolderProject } = useFolderChats(environmentId);
  const finish = useFinishNewProject();
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
      const name = folderDisplayName(current);
      await finish(await ensureFolderProject(current), name, current);
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

// ── From Cloud storage ───────────────────────────────────────────────

/**
 * Pick a folder in the account's Cloud storage; its contents are copied to
 * `~/projects/<name>` and that folder becomes the project. The cloud copy is
 * left as it is.
 */
function CloudStep({
  environmentId,
  home,
  machineLabel,
  onBack,
  onDone,
}: StepProps & { readonly machineLabel: string }) {
  const [place, setPlace] = useState<{ bucketId: number; prefix: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ensureFolderProject } = useFolderChats(environmentId);
  const finish = useFinishNewProject();
  const takenNames = useProjectsEntryNames(environmentId, home);
  const state = useQuery(cloudStateQueryOptions(environmentId));
  const buckets = state.data?.buckets ?? [];
  const onlyBucketId = state.data?.available && buckets.length === 1 ? buckets[0]!.id : null;
  // One bucket (the usual case): start inside it.
  useEffect(() => {
    if (onlyBucketId !== null) {
      setPlace((current) => current ?? { bucketId: onlyBucketId, prefix: "" });
    }
  }, [onlyBucketId]);
  const listing = useQuery({
    ...cloudListQueryOptions(environmentId, place?.bucketId ?? 0, place?.prefix ?? ""),
    enabled: place !== null,
  });
  const bucket = place ? (buckets.find((entry) => entry.id === place.bucketId) ?? null) : null;
  const folders = listing.data?.folders ?? [];
  const objects = listing.data?.objects ?? [];
  const itemCount = folders.length + objects.length;
  const tooMany = listing.data ? listing.data.truncated || itemCount > CLOUD_COPY_MAX_ITEMS : false;
  const name =
    place && bucket && takenNames
      ? freeProjectName(cloudProjectName(bucket.name, place.prefix), takenNames)
      : "";
  const target = name ? uploadedProjectPath(home, name) : null;

  const submit = async () => {
    if (!place || !target || !listing.data || itemCount === 0 || tooMany) return;
    setBusy(true);
    setError(null);
    try {
      const projectRef = await ensureFolderProject(target, name, { createFolder: true });
      await filesApi(environmentId).cloudCopyToComputer({
        bucketId: place.bucketId,
        keys: [...folders.map((folder) => folder.prefix), ...objects.map((object) => object.key)],
        destinationPath: target,
      });
      await finish(projectRef, name, target);
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Copying from Cloud storage stopped. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPanel className="flex flex-col gap-2">
        <BackToOptions onBack={onBack} />
        <nav
          aria-label="Cloud folder"
          className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs"
        >
          <button
            type="button"
            onClick={() => setPlace(null)}
            disabled={place === null || onlyBucketId !== null || busy}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent",
              place === null ? "font-semibold" : "text-muted-foreground",
            )}
          >
            <CloudIcon className="size-3" />
            Cloud storage
          </button>
          {place && bucket
            ? cloudCrumbs(bucket.name, place.prefix).map((crumb, index, all) => (
                <span key={crumb.prefix} className="flex items-center gap-0.5">
                  <ChevronRightIcon className="size-3 text-muted-foreground/60" />
                  <button
                    type="button"
                    onClick={() => setPlace({ bucketId: place.bucketId, prefix: crumb.prefix })}
                    disabled={index === all.length - 1 || busy}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent",
                      index === all.length - 1 ? "font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))
            : null}
        </nav>
        <div
          className="h-64 overflow-y-auto rounded-xl border border-border/60 bg-background/60 p-1"
          data-testid="new-project-cloud-list"
        >
          {state.isPending || (place !== null && listing.isPending) ? (
            <div className="flex flex-col gap-1.5 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-7 w-full rounded-lg" />
              ))}
            </div>
          ) : state.isError || state.data?.available === false ? (
            <p className="p-3 text-xs text-muted-foreground">
              {state.data?.message ?? "Cloud storage isn't available on this computer right now."}
            </p>
          ) : place === null ? (
            buckets.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                Nothing in your Cloud storage yet. Files you copy there from Files show up here.
              </p>
            ) : (
              <ul className="flex flex-col">
                {buckets.map((entry) => (
                  <FolderRow
                    key={entry.id}
                    name={entry.name}
                    isProject={false}
                    onClick={() => setPlace({ bucketId: entry.id, prefix: "" })}
                  />
                ))}
              </ul>
            )
          ) : listing.isError ? (
            <p className="p-3 text-xs text-destructive">
              {errorMessage(listing.error, "Can't open this folder.")}
            </p>
          ) : itemCount === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">This folder is empty.</p>
          ) : (
            <>
              <ul className="flex flex-col">
                {folders.map((folder) => (
                  <FolderRow
                    key={folder.prefix}
                    name={folder.name}
                    isProject={false}
                    onClick={() => setPlace({ bucketId: place.bucketId, prefix: folder.prefix })}
                  />
                ))}
              </ul>
              {objects.length > 0 ? (
                <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
                  {folders.length > 0 ? "and " : ""}
                  {objects.length} {objects.length === 1 ? "file" : "files"} here
                </p>
              ) : null}
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="new-project-destination">
          {tooMany ? (
            "This folder has too many items to copy in one go. Open a folder inside it."
          ) : (
            <>
              A copy goes to{" "}
              <span className="font-mono text-foreground">
                {target ? tildePath(target, home) : "~/projects/<name>"}
              </span>{" "}
              on computer {machineLabel}. The cloud copy stays.
            </>
          )}
        </p>
      </DialogPanel>
      <StepFooter
        error={error}
        busy={busy}
        disabled={place === null || !target || itemCount === 0 || tooMany || listing.isPending}
        label={place === null || !name ? "Open a folder first" : `Copy “${name}” and open`}
        icon={<CloudDownloadIcon />}
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

function EmptyStep({
  environmentId,
  home,
  wording,
  onBack,
  onDone,
}: StepProps & { readonly wording: NewProjectWording }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useProjectsEntryNames(environmentId, home);
  const { ensureFolderProject } = useFolderChats(environmentId);
  const finish = useFinishNewProject();
  const check = checkNewFolderName(name, taken ?? new Set());

  const submit = async () => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const folder = uploadedProjectPath(home, check.name);
      const projectRef = await ensureFolderProject(folder, check.name, { createFolder: true });
      await finish(projectRef, check.name, folder);
      onDone();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          wording === "folder" ? "Couldn't create the folder." : "Couldn't create the project.",
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
        <label className="text-sm font-medium" htmlFor="new-project-name">
          Name
        </label>
        <Input
          id="new-project-name"
          autoFocus
          placeholder={wording === "folder" ? "my-folder" : "my-project"}
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
          {check.ok
            ? `Creates ${tildePath(uploadedProjectPath(home, check.name), home)}`
            : "Creates ~/projects/<name>"}{" "}
          on this computer.
        </p>
      </DialogPanel>
      <StepFooter
        error={error ?? (name.trim().length > 0 && !check.ok ? check.error : null)}
        busy={busy}
        disabled={!check.ok || taken === null}
        label={wording === "folder" ? "Create folder" : "Create project"}
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
  const taken = useProjectsEntryNames(environmentId, home);
  const { ensureFolderProject } = useFolderChats(environmentId);
  const finish = useFinishNewProject();
  const wording = useNewProjectStore((state) => state.wording);
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
      const destinationPath = uploadedProjectPath(home, check.name);
      const result = await ensureEnvironmentApi(environmentId).sourceControl.cloneRepository({
        remoteUrl: check.remoteUrl,
        destinationPath,
      });
      const folder = result.cwd || destinationPath;
      await finish(await ensureFolderProject(folder, check.name), check.name, folder);
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
            ? `Clones into ${tildePath(uploadedProjectPath(home, check.name), home)}`
            : "Clones into ~/projects/<repo>"}
        </p>
      </DialogPanel>
      <StepFooter
        error={error ?? (input.trim().length > 0 && !check.ok ? check.error : null)}
        busy={busy}
        disabled={!check.ok || taken === null}
        label={busy ? "Cloning…" : wording === "folder" ? "Clone" : "Clone and open"}
        icon={<GitHubIcon />}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
    </>
  );
}
