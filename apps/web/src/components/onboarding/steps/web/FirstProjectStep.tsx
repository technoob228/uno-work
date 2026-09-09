import { ArrowLeft, CheckCircle2, FolderUp, GitBranch, GraduationCap, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";

import {
  UPLOAD_MAX_FILE_BYTES,
  inferProjectNameFromUpload,
  isLikelyGitRemoteUrl,
  pickFirstProjectModelSelection,
  type FirstProjectMode,
} from "~/firstProject";
import {
  runCloneFirstProject,
  runTutorialFirstProject,
  runUploadFirstProject,
  type FirstProjectResult,
  type FirstProjectRunnerDeps,
} from "~/firstProjectRunner";
import { createEnvironmentApi } from "~/environmentApi";
import { toFirstProjectFiles } from "~/firstProjectFiles";
import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { useSettings } from "~/hooks/useSettings";
import { useServerConfig, useServerProviders } from "~/rpc/serverState";
import { newCommandId, newProjectId, cn } from "~/lib/utils";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { StepEyebrow, StepLead, StepTitle } from "../stepShared";

const DEFAULT_WEB_WORKSPACE_ROOT = "~/projects";

export interface FirstProjectStepProps {
  /** Called once a project exists so the shell can close onboarding. */
  onProjectReady: (result: FirstProjectResult) => void;
}

interface ModeCardProps {
  icon: typeof GitBranch;
  title: string;
  description: string;
  onSelect: () => void;
}

function ModeCard({ icon: Icon, title, description, onSelect }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/50 hover:bg-primary/5"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4.5" />
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>
    </button>
  );
}

export function FirstProjectStep({ onProjectReady }: FirstProjectStepProps) {
  const serverConfig = useServerConfig();
  const providers = useServerProviders();
  const configuredBaseDirectory = useSettings(
    (settings) => settings.addProjectBaseDirectory?.trim() ?? "",
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<FirstProjectMode | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<FirstProjectResult | null>(null);

  const baseDirectory =
    configuredBaseDirectory.length > 0 ? configuredBaseDirectory : DEFAULT_WEB_WORKSPACE_ROOT;

  const modelSelection = useMemo(
    () =>
      pickFirstProjectModelSelection(
        providers.map((provider) => ({
          instanceId: provider.instanceId,
          status: provider.status,
          models: provider.models.map((model) => ({ slug: model.slug })),
        })),
        { instanceId: "codex", model: DEFAULT_MODEL },
      ),
    [providers],
  );

  // The onboarding route renders outside the chat layout, so the primary
  // connection may not be registered yet — ask the runtime to create it.
  const buildDeps = useCallback(async (): Promise<FirstProjectRunnerDeps | null> => {
    const connection = getPrimaryEnvironmentConnection();
    await connection.ensureBootstrapped();
    const api = createEnvironmentApi(connection.client);

    return {
      cloneRepository: (input) => api.sourceControl.cloneRepository(input),
      writeFile: (input) => api.projects.writeFile(input),
      createProject: async ({ cwd, title }) => {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId: newProjectId(),
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make(modelSelection.instanceId),
            model: modelSelection.model,
          },
          createdAt: new Date().toISOString(),
        });
      },
      onProgress: setProgress,
    };
  }, [modelSelection]);

  const run = useCallback(
    async (task: (deps: FirstProjectRunnerDeps) => Promise<FirstProjectResult>) => {
      setPending(true);
      setError(null);
      setProgress(null);
      try {
        const deps = await buildDeps();
        if (!deps) {
          setError("Not connected to the machine yet. Give it a moment and try again.");
          return;
        }
        const result = await task(deps);
        setDone(result);
        onProjectReady(result);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Something went wrong.");
      } finally {
        setPending(false);
      }
    },
    [buildDeps, onProjectReady],
  );

  const handleClone = () => {
    const trimmed = remoteUrl.trim();
    if (!isLikelyGitRemoteUrl(trimmed)) {
      setError("That does not look like a repository. Try owner/repo or a full git URL.");
      return;
    }
    void run((deps) => runCloneFirstProject(deps, { remoteUrl: trimmed, baseDirectory }));
  };

  const handleFilesPicked = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = toFirstProjectFiles(fileList);
    const projectName = inferProjectNameFromUpload(files);
    void run((deps) => runUploadFirstProject(deps, { files, baseDirectory, projectName }));
  };

  const handleTutorial = () => {
    void run((deps) => runTutorialFirstProject(deps, { baseDirectory }));
  };

  if (done) {
    const skipped = done.uploadPlan?.skipped.length ?? 0;
    return (
      <div className="m-auto flex w-full max-w-xl flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-6" />
        </span>
        <StepTitle>{done.title} is ready</StepTitle>
        <p className="font-mono text-xs text-muted-foreground">{done.cwd}</p>
        {skipped > 0 ? (
          <p className="text-xs text-muted-foreground">
            {skipped} file{skipped === 1 ? "" : "s"} skipped (dependency folders, git metadata, or
            files over {Math.round(UPLOAD_MAX_FILE_BYTES / (1024 * 1024))} MB).
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Continue to open it and start your first thread.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <StepEyebrow>First project</StepEyebrow>
      <StepTitle>Put something on the machine</StepTitle>
      <StepLead>
        The agent works on files that live on {serverConfig?.environment.label ?? "your machine"}.
        Bring an existing repository, upload a folder from this computer, or start with a small
        guided project.
      </StepLead>

      {mode === null ? (
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <ModeCard
            icon={GitBranch}
            title="Clone a repository"
            description="Paste a git URL or owner/repo. Private repos need credentials on the machine."
            onSelect={() => setMode("clone")}
          />
          <ModeCard
            icon={FolderUp}
            title="Upload files"
            description="Pick a folder on this computer. It is copied to the machine, minus build junk."
            onSelect={() => setMode("upload")}
          />
          <ModeCard
            icon={GraduationCap}
            title="Guided tutorial"
            description="A tiny sample project with a task list that teaches the ask → diff → run loop."
            onSelect={() => setMode("tutorial")}
          />
        </div>
      ) : (
        <div className="mt-10 max-w-xl">
          <Button
            variant="ghost"
            size="xs"
            className="mb-4 -ml-2"
            onClick={() => {
              setMode(null);
              setError(null);
            }}
            disabled={pending}
          >
            <ArrowLeft className="size-3.5" />
            All options
          </Button>

          {mode === "clone" ? (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-semibold" htmlFor="first-project-remote">
                Repository
              </label>
              <div className="flex gap-2">
                <Input
                  id="first-project-remote"
                  autoFocus
                  placeholder="uno/work or https://github.com/uno/work.git"
                  value={remoteUrl}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleClone();
                  }}
                  disabled={pending}
                />
                <Button onClick={handleClone} disabled={pending || remoteUrl.trim().length === 0}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Clone
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Cloned into <span className="font-mono">{baseDirectory}</span>
              </p>
            </div>
          ) : null}

          {mode === "upload" ? (
            <div className="flex flex-col gap-3">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                // @ts-expect-error non-standard but supported in Chromium/WebKit/Firefox
                webkitdirectory=""
                directory=""
                onChange={(event) => handleFilesPicked(event.target.files)}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={pending}
                className="h-24 border-dashed"
              >
                {pending ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {progress ? `Uploading ${progress.completed}/${progress.total}` : "Reading…"}
                  </span>
                ) : (
                  <span className="flex flex-col items-center gap-1">
                    <FolderUp className="size-5" />
                    <span className="text-sm font-semibold">Choose a folder</span>
                  </span>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Copied to <span className="font-mono">{baseDirectory}</span>. Dependency folders,
                git metadata and files over {Math.round(UPLOAD_MAX_FILE_BYTES / (1024 * 1024))} MB
                are skipped — clone or <span className="font-mono">git pull</span> from the terminal
                for anything larger.
              </p>
            </div>
          ) : null}

          {mode === "tutorial" ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Creates <span className="font-mono">{baseDirectory}/uno-work-tutorial</span> with a
                sample dataset, a small script, and a README of things to try.
              </p>
              <Button onClick={handleTutorial} disabled={pending} className="self-start">
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Create tutorial project
              </Button>
            </div>
          ) : null}

          {error ? (
            <p className={cn("mt-4 text-sm", "text-destructive")} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
