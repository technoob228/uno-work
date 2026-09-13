/**
 * "Continue on <machine>" — the environment-independent orchestration.
 *
 * The client drives two daemons: `prepare` on the machine the chat lives on
 * (snapshot + push), `receive` on the machine it moves to (fetch + restore +
 * new thread), `cleanup` on the source (drop the transport branch, best
 * effort), then `complete` back on the source (mark / archive), then it
 * opens the new chat. Before any of that, `inspect` on the target tells the
 * dialog whether the receive would overwrite local work there. Every
 * dependency is injected so the step machine can be tested without live
 * daemons; the dialog supplies real environment APIs.
 *
 * Progress is checkpointed so a retry resumes at the failed step instead of
 * pushing (or cloning) twice.
 */
import type {
  EnvironmentId,
  ProjectId,
  ThreadContinueCleanupInput,
  ThreadContinueCleanupResult,
  ThreadContinueCompleteInput,
  ThreadContinueCompleteResult,
  ThreadContinueInspectInput,
  ThreadContinueInspectResult,
  ThreadContinuePrepareInput,
  ThreadContinuePrepareResult,
  ThreadContinueReceiveInput,
  ThreadContinueReceiveProject,
  ThreadContinueReceiveResult,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import {
  CONTINUE_SEED_PREFIX,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_STARTS,
} from "@t3tools/shared/handoff";

import { moveProjectDestination } from "./moveProjectToBox";
import type { Project } from "./types";

export type ContinueOnMachineStep =
  | "connecting"
  | "saving"
  | "preparing"
  | "cleaning"
  | "marking"
  | "opening";

export const CONTINUE_ON_MACHINE_STEPS: ReadonlyArray<ContinueOnMachineStep> = [
  "connecting",
  "saving",
  "preparing",
  "cleaning",
  "marking",
  "opening",
];

/** Where the chat lands on the target; `remoteUrl` for `create` comes from the prepare result. */
export type ContinueTargetProject =
  | { readonly kind: "existing"; readonly projectPath: string; readonly title: string }
  | { readonly kind: "create"; readonly destinationPath: string; readonly title: string };

/** The target-side path `inspect` and `receive` look at for a chosen project. */
export function continueTargetProjectPath(target: ContinueTargetProject): string {
  return target.kind === "existing" ? target.projectPath : target.destinationPath;
}

export interface ContinueOnMachineDeps {
  /** Makes sure the target environment has a live connection before any RPC. */
  readonly ensureTargetConnected: () => Promise<void>;
  /** `thread.continue.inspect` on the TARGET environment (read-only). */
  readonly inspect: (input: ThreadContinueInspectInput) => Promise<ThreadContinueInspectResult>;
  /** `thread.continue.prepare` on the SOURCE environment. */
  readonly prepare: (input: ThreadContinuePrepareInput) => Promise<ThreadContinuePrepareResult>;
  /** `thread.continue.receive` on the TARGET environment. */
  readonly receive: (input: ThreadContinueReceiveInput) => Promise<ThreadContinueReceiveResult>;
  /** `thread.continue.cleanup` on the SOURCE environment; a failure never stops the run. */
  readonly cleanup: (input: ThreadContinueCleanupInput) => Promise<ThreadContinueCleanupResult>;
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
  /** Recorded once attempted, even when the branch stayed: cleanup is not retried. */
  readonly cleanedUp?: ThreadContinueCleanupResult;
  readonly completed?: ThreadContinueCompleteResult;
}

export interface ContinueOnMachineResult {
  readonly prepared: ThreadContinuePrepareResult;
  readonly received: ThreadContinueReceiveResult;
  readonly cleanedUp: ThreadContinueCleanupResult;
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

  // The target has the files now; the transport branch is only clutter on the
  // remote. Failing to remove it must not undo a handoff that worked, so the
  // outcome is recorded and shown as a note rather than thrown.
  const cleanedUp =
    current.cleanedUp ??
    (await step("cleaning", async () => {
      try {
        return await deps.cleanup({
          threadId: input.sourceThreadId,
          remote: prepared.remoteName,
        });
      } catch {
        return { branch: prepared.branch, removed: false };
      }
    }));
  current = { ...current, cleanedUp };

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

  return { prepared, received, cleanedUp, completed };
}

/**
 * Read-only look at the chosen project on the target, before anything runs.
 * Throws when the target cannot be reached or inspected; the dialog keeps
 * the primary button disabled until this succeeds.
 */
export async function inspectContinueTarget(
  deps: Pick<ContinueOnMachineDeps, "ensureTargetConnected" | "inspect">,
  target: ContinueTargetProject,
): Promise<ThreadContinueInspectResult> {
  await deps.ensureTargetConnected();
  return deps.inspect({ projectPath: continueTargetProjectPath(target) });
}

/** What the dialog says about the target project before the run starts. */
export type ContinueTargetState =
  /** Nothing at the path yet: the project will be cloned there. */
  | { readonly kind: "missing"; readonly destinationPath: string }
  /** The folder exists but is not a git checkout; `receive` would refuse it. */
  | { readonly kind: "not-git"; readonly projectPath: string }
  /** A clean checkout: files are updated, nothing of the target's own is lost. */
  | { readonly kind: "clean"; readonly branch: string | null }
  /** Uncommitted work on the target that the copy would replace. */
  | { readonly kind: "changes"; readonly changedFiles: number; readonly branch: string | null };

export function describeContinueTarget(
  inspection: ThreadContinueInspectResult,
  target: ContinueTargetProject,
): ContinueTargetState {
  if (!inspection.exists) {
    return { kind: "missing", destinationPath: continueTargetProjectPath(target) };
  }
  if (!inspection.isGitRepository) {
    return { kind: "not-git", projectPath: inspection.projectPath };
  }
  if (inspection.hasLocalChanges) {
    return { kind: "changes", changedFiles: inspection.changedFiles, branch: inspection.branch };
  }
  return { kind: "clean", branch: inspection.branch };
}

/**
 * Whether the primary button may be enabled: the target must have been
 * inspected, must be usable, and when it carries local changes the person
 * must have ticked "Replace them".
 */
export function canStartContinue(input: {
  readonly targetState: ContinueTargetState | null;
  readonly replaceConfirmed: boolean;
}): boolean {
  switch (input.targetState?.kind) {
    case "missing":
    case "clean":
      return true;
    case "changes":
      return input.replaceConfirmed;
    case "not-git":
    case undefined:
      return false;
  }
}

export interface HandoffSeedSummary {
  /** Machine the chat came from; null for handoffs that carry no header (Telegram). */
  readonly sourceMachineLabel: string | null;
  /** `User:` / `Assistant:` lines inside the preamble. */
  readonly earlierMessages: number;
  /** What follows the preamble: the person's own message, or a model note; empty for a plain seed. */
  readonly tail: string;
}

/**
 * A user message that opens with a handoff preamble: the seed of a continued
 * chat, or a Telegram message that carries the history of a replaced thread.
 * Only a leading preamble counts; one quoted in the middle of a message is
 * the person's own text.
 */
export function isHandoffSeed(text: string): boolean {
  return findLeadingPreambleStart(text) !== null;
}

function findLeadingPreambleStart(
  text: string,
): { readonly index: number; readonly marker: string } | null {
  const trimmed = text.trimStart();
  const header = trimmed.startsWith(CONTINUE_SEED_PREFIX)
    ? trimmed.slice(0, Math.max(0, trimmed.indexOf("\n")))
    : "";
  const body = trimmed.slice(header.length).trimStart();
  for (const marker of HANDOFF_PREAMBLE_STARTS) {
    if (body.startsWith(marker)) {
      return { index: text.length - body.length, marker };
    }
  }
  return null;
}

const TRANSCRIPT_LINE = /^(?:User|Assistant): /;

/** Header, count and tail of a handoff seed, for the collapsed card. Call after `isHandoffSeed`. */
export function describeHandoffSeed(text: string): HandoffSeedSummary {
  const start = findLeadingPreambleStart(text);
  const head = start === null ? "" : text.slice(0, start.index).trimStart();
  const sourceMachineLabel = head.startsWith(CONTINUE_SEED_PREFIX)
    ? (head.slice(CONTINUE_SEED_PREFIX.length).split("]")[0]?.trim() ?? null) || null
    : null;
  if (start === null) {
    return { sourceMachineLabel, earlierMessages: 0, tail: text.trim() };
  }
  const bodyStart = start.index + start.marker.length;
  const endIndex = text.indexOf(HANDOFF_PREAMBLE_END, bodyStart);
  const transcript = endIndex === -1 ? text.slice(bodyStart) : text.slice(bodyStart, endIndex);
  const earlierMessages = transcript
    .split("\n")
    .filter((line) => TRANSCRIPT_LINE.test(line)).length;
  const tail = endIndex === -1 ? "" : text.slice(endIndex + HANDOFF_PREAMBLE_END.length).trim();
  return { sourceMachineLabel, earlierMessages, tail };
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
