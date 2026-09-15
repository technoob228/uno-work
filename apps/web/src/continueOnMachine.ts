/**
 * "Continue on <machine>" — the environment-independent orchestration.
 *
 * The client drives two daemons and carries the files between them itself:
 * `snapshot` on the machine the chat lives on packs the working tree into a
 * bundle, the client reads it chunk by chunk from there and writes the same
 * chunks to the machine it moves to, `land` there opens a new worktree with
 * the files and creates the chat, `complete` back on the source marks the old
 * chat, then the new one opens. Nothing goes through GitHub or any other git
 * remote. Before any of that, `inspect` on the target tells the dialog whether
 * the project is already there.
 *
 * Every dependency is injected so the step machine can be tested without live
 * daemons; the dialog supplies real environment APIs. Progress is
 * checkpointed so a retry resumes at the failed step (and at the first chunk
 * that did not arrive) instead of starting over.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectId,
  ThreadContinueCompleteInput,
  ThreadContinueCompleteResult,
  ThreadContinueDiscardInput,
  ThreadContinueDiscardResult,
  ThreadContinueInspectInput,
  ThreadContinueInspectResult,
  ThreadContinueLandInput,
  ThreadContinueLandProject,
  ThreadContinueLandResult,
  ThreadContinueReadChunkInput,
  ThreadContinueReadChunkResult,
  ThreadContinueSnapshotInput,
  ThreadContinueSnapshotResult,
  ThreadContinueWriteChunkInput,
  ThreadContinueWriteChunkResult,
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
  | "sending"
  | "preparing"
  | "marking"
  | "opening";

export const CONTINUE_ON_MACHINE_STEPS: ReadonlyArray<ContinueOnMachineStep> = [
  "connecting",
  "saving",
  "sending",
  "preparing",
  "marking",
  "opening",
];

/** Where the chat lands on the target; `remoteUrl` for `create` comes from the snapshot. */
export type ContinueTargetProject =
  | { readonly kind: "existing"; readonly projectPath: string; readonly title: string }
  | { readonly kind: "create"; readonly destinationPath: string; readonly title: string };

/** The target-side path `inspect` and `land` look at for a chosen project. */
export function continueTargetProjectPath(target: ContinueTargetProject): string {
  return target.kind === "existing" ? target.projectPath : target.destinationPath;
}

/**
 * Whether a daemon speaks the direct protocol. Daemons from 0.0.53–0.0.56
 * pushed files through `origin`; the client never continues to or from them.
 */
export function descriptorSupportsDirectContinue(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.threadContinueDirect === true;
}

/** Thrown before anything runs when either machine needs an update. */
export class ContinueUpdateRequiredError extends Error {
  readonly machineLabel: string;
  constructor(machineLabel: string) {
    super(
      `Update Uno Work on ${machineLabel} first. This version sends the files directly between your machines, and ${machineLabel} still runs the older version that sent them through GitHub.`,
    );
    this.name = "ContinueUpdateRequiredError";
    this.machineLabel = machineLabel;
  }
}

/**
 * The first machine that blocks the run, or null when both speak the direct
 * protocol. A descriptor that is not known yet counts as blocking: the check
 * runs again after connecting, when it is.
 */
export function findMachineNeedingUpdate(
  machines: ReadonlyArray<{
    readonly label: string;
    readonly descriptor: ExecutionEnvironmentDescriptor | null | undefined;
  }>,
): string | null {
  return (
    machines.find((machine) => !descriptorSupportsDirectContinue(machine.descriptor))?.label ?? null
  );
}

export interface ContinueOnMachineDeps {
  /** Makes sure the target environment has a live connection before any RPC. */
  readonly ensureTargetConnected: () => Promise<void>;
  /**
   * Throws `ContinueUpdateRequiredError` when the source or the target does
   * not advertise `threadContinueDirect`. Runs after connecting, so the
   * target's descriptor is fresh.
   */
  readonly assertMachinesSupported: () => void;
  /** `thread.continue.inspect` on the TARGET environment (read-only). */
  readonly inspect: (input: ThreadContinueInspectInput) => Promise<ThreadContinueInspectResult>;
  /** `thread.continue.snapshot` on the SOURCE environment. */
  readonly snapshot: (input: ThreadContinueSnapshotInput) => Promise<ThreadContinueSnapshotResult>;
  /** `thread.continue.readChunk` on the SOURCE environment. */
  readonly readChunk: (
    input: ThreadContinueReadChunkInput,
  ) => Promise<ThreadContinueReadChunkResult>;
  /** `thread.continue.writeChunk` on the TARGET environment. */
  readonly writeChunk: (
    input: ThreadContinueWriteChunkInput,
  ) => Promise<ThreadContinueWriteChunkResult>;
  /** `thread.continue.land` on the TARGET environment. */
  readonly land: (input: ThreadContinueLandInput) => Promise<ThreadContinueLandResult>;
  /** `thread.continue.discard` on the SOURCE environment; a failure never stops the run. */
  readonly discardSource: (
    input: ThreadContinueDiscardInput,
  ) => Promise<ThreadContinueDiscardResult>;
  /** `thread.continue.complete` on the SOURCE environment. */
  readonly complete: (input: ThreadContinueCompleteInput) => Promise<ThreadContinueCompleteResult>;
  /** Switch to the target environment and navigate to the new thread. */
  readonly openThread: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Promise<void>;
  readonly onStep?: (step: ContinueOnMachineStep) => void;
  /** Bytes that reached the target so far, out of `totalBytes`. */
  readonly onSendProgress?: (sentBytes: number, totalBytes: number) => void;
}

export interface ContinueOnMachineInput {
  readonly sourceThreadId: ThreadId;
  readonly targetMachineLabel: string;
  readonly targetProject: ContinueTargetProject;
  /** Send `.env` along. Off unless the person ticked the box. */
  readonly copyEnv: boolean;
  readonly archiveSource: boolean;
}

/** What has already succeeded; passed back in on retry so finished steps are skipped. */
export interface ContinueOnMachineProgress {
  readonly snapshot?: ThreadContinueSnapshotResult;
  /** Chunks that reached the target, in order. */
  readonly sentChunks?: number;
  readonly landed?: ThreadContinueLandResult;
  readonly completed?: ThreadContinueCompleteResult;
}

export interface ContinueOnMachineResult {
  readonly snapshot: ThreadContinueSnapshotResult;
  readonly landed: ThreadContinueLandResult;
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

/** `reason` of a `ThreadContinueError` that crossed the RPC boundary, if any. */
export function continueErrorReason(cause: unknown): string | null {
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = (cause as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

export function toLandProject(
  target: ContinueTargetProject,
  remoteUrl: string | null,
): ThreadContinueLandProject {
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

  // Always re-checked: a retry may follow a dropped connection or an update.
  await step("connecting", async () => {
    await deps.ensureTargetConnected();
    deps.assertMachinesSupported();
  });

  const snapshot =
    current.snapshot ??
    (await step("saving", () =>
      deps.snapshot({ threadId: input.sourceThreadId, includeEnv: input.copyEnv }),
    ));
  current = { ...current, snapshot };

  if (!current.landed) {
    await step("sending", async () => {
      let sent = current.sentChunks ?? 0;
      let restarted = false;
      deps.onSendProgress?.(
        Math.min(sent * snapshot.chunkBytes, snapshot.sizeBytes),
        snapshot.sizeBytes,
      );
      while (sent < snapshot.chunkCount) {
        try {
          const chunk = await deps.readChunk({ transferId: snapshot.transferId, index: sent });
          const { receivedBytes } = await deps.writeChunk({
            transferId: snapshot.transferId,
            offset: sent * snapshot.chunkBytes,
            data: chunk.data,
          });
          sent += 1;
          current = { ...current, sentChunks: sent };
          deps.onSendProgress?.(receivedBytes, snapshot.sizeBytes);
        } catch (cause) {
          const reason = continueErrorReason(cause);
          if (reason === "transfer_not_found") {
            // The source no longer has the bundle (swept or restarted): a
            // retry has to take a new snapshot.
            const { snapshot: _stale, ...rest } = current;
            current = { ...rest, sentChunks: 0 };
            throw cause;
          }
          if (reason === "transfer_incomplete" && sent > 0 && !restarted) {
            // The target lost what it had (e.g. restarted): send it all again, once.
            restarted = true;
            sent = 0;
            current = { ...current, sentChunks: 0 };
            continue;
          }
          throw cause;
        }
      }
    });
  }

  const landed =
    current.landed ??
    (await step("preparing", () =>
      landOrForgetChunks({
        transferId: snapshot.transferId,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256,
        commit: snapshot.commit,
        baseCommit: snapshot.baseCommit,
        project: toLandProject(input.targetProject, snapshot.remoteUrl),
        title: snapshot.title,
        modelSelection: snapshot.modelSelection,
        runtimeMode: snapshot.runtimeMode,
        interactionMode: snapshot.interactionMode,
        seedText: snapshot.seedText,
        envText: input.copyEnv ? snapshot.envText : null,
        sourceMachineLabel: snapshot.sourceMachineLabel,
        sourceThreadId: snapshot.sourceThreadId,
      }),
    ));

  async function landOrForgetChunks(landInput: ThreadContinueLandInput) {
    try {
      return await deps.land(landInput);
    } catch (cause) {
      const reason = continueErrorReason(cause);
      if (reason === "transfer_incomplete" || reason === "transfer_not_found") {
        // What arrived is unusable; a retry sends the files again.
        current = { ...current, sentChunks: 0 };
      }
      throw cause;
    }
  }
  if (!current.landed) {
    // The target has its copy; the source's bundle is only clutter. The
    // daemon also sweeps old bundles, so a failure here is ignored.
    await deps.discardSource({ transferId: snapshot.transferId }).catch(() => undefined);
  }
  current = { ...current, landed };

  const completed =
    current.completed ??
    (await step("marking", () =>
      deps.complete({
        threadId: input.sourceThreadId,
        targetMachineLabel: input.targetMachineLabel,
        targetThreadId: landed.threadId,
        archive: input.archiveSource,
      }),
    ));
  current = { ...current, completed };

  await step("opening", () =>
    deps.openThread({ threadId: landed.threadId, projectId: landed.projectId }),
  );

  return { snapshot, landed, completed };
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
  /** Nothing at the path yet: the project will be added there. */
  | { readonly kind: "missing"; readonly destinationPath: string }
  /** The folder exists but is not a git checkout; `land` would refuse it. */
  | { readonly kind: "not-git"; readonly projectPath: string }
  /** The project is there; the chat opens in a new worktree beside it. */
  | { readonly kind: "exists"; readonly projectPath: string };

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
  return { kind: "exists", projectPath: inspection.projectPath };
}

/**
 * Whether the primary button may be enabled: the target must have been
 * inspected and be usable, and neither machine may need an update. Nothing
 * on the target is overwritten, so there is nothing to confirm.
 */
export function canStartContinue(input: {
  readonly targetState: ContinueTargetState | null;
  readonly machineNeedingUpdate: string | null;
}): boolean {
  if (input.machineNeedingUpdate !== null) {
    return false;
  }
  switch (input.targetState?.kind) {
    case "missing":
    case "exists":
      return true;
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
