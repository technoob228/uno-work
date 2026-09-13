/**
 * "Continue on <machine>" — the environment-independent orchestration.
 *
 * The client drives two daemons: `prepare` on the machine the chat lives on
 * (snapshot + push), `receive` on the machine it moves to (fetch + restore +
 * new thread), then `complete` back on the source (mark / archive), then it
 * opens the new chat. Every dependency is injected so the step machine can
 * be tested without live daemons; the dialog supplies real environment APIs.
 *
 * Progress is checkpointed so a retry resumes at the failed step instead of
 * pushing (or cloning) twice.
 */
import type {
  EnvironmentId,
  ProjectId,
  ThreadContinueCompleteInput,
  ThreadContinueCompleteResult,
  ThreadContinuePrepareInput,
  ThreadContinuePrepareResult,
  ThreadContinueReceiveInput,
  ThreadContinueReceiveProject,
  ThreadContinueReceiveResult,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import { moveProjectDestination } from "./moveProjectToBox";
import type { Project } from "./types";

export type ContinueOnMachineStep = "connecting" | "saving" | "preparing" | "marking" | "opening";

export const CONTINUE_ON_MACHINE_STEPS: ReadonlyArray<ContinueOnMachineStep> = [
  "connecting",
  "saving",
  "preparing",
  "marking",
  "opening",
];

/** Where the chat lands on the target; `remoteUrl` for `create` comes from the prepare result. */
export type ContinueTargetProject =
  | { readonly kind: "existing"; readonly projectPath: string; readonly title: string }
  | { readonly kind: "create"; readonly destinationPath: string; readonly title: string };

export interface ContinueOnMachineDeps {
  /** Makes sure the target environment has a live connection before any RPC. */
  readonly ensureTargetConnected: () => Promise<void>;
  /** `thread.continue.prepare` on the SOURCE environment. */
  readonly prepare: (input: ThreadContinuePrepareInput) => Promise<ThreadContinuePrepareResult>;
  /** `thread.continue.receive` on the TARGET environment. */
  readonly receive: (input: ThreadContinueReceiveInput) => Promise<ThreadContinueReceiveResult>;
  /** `thread.continue.complete` on the SOURCE environment. */
  readonly complete: (input: ThreadContinueCompleteInput) => Promise<ThreadContinueCompleteResult>;
  /** Switch to the target environment and navigate to the new thread. */
  readonly openThread: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Promise<void>;
  readonly onStep?: (step: ContinueOnMachineStep) => void;
}

export interface ContinueOnMachineInput {
  readonly sourceThreadId: ThreadId;
  readonly targetMachineLabel: string;
  readonly targetProject: ContinueTargetProject;
  readonly copyEnv: boolean;
  readonly archiveSource: boolean;
}

/** What has already succeeded; passed back in on retry so finished steps are skipped. */
export interface ContinueOnMachineProgress {
  readonly prepared?: ThreadContinuePrepareResult;
  readonly received?: ThreadContinueReceiveResult;
  readonly completed?: ThreadContinueCompleteResult;
}

export interface ContinueOnMachineResult {
  readonly prepared: ThreadContinuePrepareResult;
  readonly received: ThreadContinueReceiveResult;
  readonly completed: ThreadContinueCompleteResult;
}

export class ContinueOnMachineFailure extends Error {
  readonly step: ContinueOnMachineStep;
  readonly progress: ContinueOnMachineProgress;
  override readonly cause: unknown;

  constructor(step: ContinueOnMachineStep, progress: ContinueOnMachineProgress, cause: unknown) {
    super(describeFailure(cause));
    this.name = "ContinueOnMachineFailure";
    this.step = step;
    this.progress = progress;
    this.cause = cause;
  }
}

function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "Something went wrong.";
}

export function toReceiveProject(
  target: ContinueTargetProject,
  remoteUrl: string,
): ThreadContinueReceiveProject {
  return target.kind === "existing"
    ? { kind: "existing", projectPath: target.projectPath }
    : { kind: "create", remoteUrl, destinationPath: target.destinationPath, title: target.title };
}

/**
 * Runs the steps in order, skipping the ones `progress` says are done.
 * Throws `ContinueOnMachineFailure` with the step and the progress so far;
 * the caller retries with that progress.
 */
export async function runContinueOnMachine(
  deps: ContinueOnMachineDeps,
  input: ContinueOnMachineInput,
  progress: ContinueOnMachineProgress = {},
): Promise<ContinueOnMachineResult> {
  let current: ContinueOnMachineProgress = progress;
  const step = async <T>(name: ContinueOnMachineStep, run: () => Promise<T>): Promise<T> => {
    deps.onStep?.(name);
    try {
      return await run();
    } catch (cause) {
      throw new ContinueOnMachineFailure(name, current, cause);
    }
  };

  // Always re-checked: a retry may follow a dropped connection.
  await step("connecting", () => deps.ensureTargetConnected());

  const prepared =
    current.prepared ??
    (await step("saving", () =>
      deps.prepare({ threadId: input.sourceThreadId, includeEnv: input.copyEnv }),
    ));
  current = { ...current, prepared };

  const received =
    current.received ??
    (await step("preparing", () =>
      deps.receive({
        project: toReceiveProject(input.targetProject, prepared.remoteUrl),
        remoteUrl: prepared.remoteUrl,
        branch: prepared.branch,
        commit: prepared.commit,
        title: prepared.title,
        modelSelection: prepared.modelSelection,
        runtimeMode: prepared.runtimeMode,
        interactionMode: prepared.interactionMode,
        seedText: prepared.seedText,
        envText: input.copyEnv ? prepared.envText : null,
        sourceMachineLabel: prepared.sourceMachineLabel,
        sourceThreadId: prepared.sourceThreadId,
      }),
    ));
  current = { ...current, received };

  const completed =
    current.completed ??
    (await step("marking", () =>
      deps.complete({
        threadId: input.sourceThreadId,
        targetMachineLabel: input.targetMachineLabel,
        targetThreadId: received.threadId,
        archive: input.archiveSource,
      }),
    ));
  current = { ...current, completed };

  await step("opening", () =>
    deps.openThread({ threadId: received.threadId, projectId: received.projectId }),
  );

  return { prepared, received, completed };
}

function projectRemoteKey(project: Pick<Project, "repositoryIdentity">): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  const key = identity.canonicalKey?.trim();
  if (key && key.length > 0) return key.toLowerCase();
  const remoteUrl = identity.locator?.remoteUrl?.trim();
  return remoteUrl && remoteUrl.length > 0 ? normalizeGitRemoteUrl(remoteUrl) : null;
}

/**
 * Where the chat should land on the target machine: a project there that
 * points at the same git remote, else a fresh clone under the target's
 * project folder. Same naming as "Move to a box".
 */
export function resolveContinueTargetProject(input: {
  readonly sourceProject: Pick<Project, "name" | "repositoryIdentity">;
  readonly targetEnvironmentId: EnvironmentId;
  readonly projects: ReadonlyArray<
    Pick<Project, "environmentId" | "cwd" | "name" | "repositoryIdentity">
  >;
  readonly targetBaseDirectory: string;
}): ContinueTargetProject {
  const sourceKey = projectRemoteKey(input.sourceProject);
  if (sourceKey !== null) {
    const match = input.projects.find(
      (project) =>
        project.environmentId === input.targetEnvironmentId &&
        projectRemoteKey(project) === sourceKey,
    );
    if (match) {
      return { kind: "existing", projectPath: match.cwd, title: match.name };
    }
  }
  const { title, destinationPath } = moveProjectDestination({
    projectName: input.sourceProject.name,
    targetBaseDirectory: input.targetBaseDirectory,
  });
  return { kind: "create", destinationPath, title };
}

/** Polls `check` until it is true or the deadline passes. */
export async function waitUntil(
  check: () => boolean,
  options: { readonly timeoutMs: number; readonly intervalMs?: number },
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
