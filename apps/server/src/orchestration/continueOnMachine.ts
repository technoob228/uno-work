/**
 * "Continue on <machine>" — the RPC handlers.
 *
 * `snapshot` and `readChunk` run on the daemon the chat lives on,
 * `writeChunk` and `land` on the daemon it moves to, `complete` on the source
 * again; `inspect` is the read-only look at the target and `discard` drops a
 * bundle on either side. The web client carries the bytes and sequences the
 * calls; see `packages/contracts/src/threadContinue.ts`. Nothing here pushes
 * to a git remote.
 *
 * Dependencies are passed explicitly (same pattern as `plugins/panelThread.ts`)
 * so the handlers are testable with a fake transport and fake projections,
 * and `ws.ts` stays a thin wiring layer. The git side lives in
 * `git/continueTransport.ts`, the bundle files in
 * `git/continueTransferStore.ts`, the seed text in `handoff.ts`.
 */
import {
  CommandId,
  EventId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ProjectId,
  type ServerProvider,
  THREAD_CONTINUE_BRANCH_PREFIX,
  THREAD_CONTINUE_CHUNK_BYTES,
  THREAD_CONTINUE_LEGACY_CLIENT_MESSAGE,
  THREAD_CONTINUE_MAX_BUNDLE_BYTES,
  ThreadContinueError,
  type ThreadContinueErrorReason,
  type ThreadContinueCompleteInput,
  type ThreadContinueCompleteResult,
  type ThreadContinueDiscardInput,
  type ThreadContinueDiscardResult,
  type ThreadContinueInspectInput,
  type ThreadContinueInspectResult,
  type ThreadContinueLandInput,
  type ThreadContinueLandResult,
  type ThreadContinueReadChunkInput,
  type ThreadContinueReadChunkResult,
  type ThreadContinueSnapshotInput,
  type ThreadContinueSnapshotResult,
  type ThreadContinueWriteChunkInput,
  type ThreadContinueWriteChunkResult,
  ThreadId,
} from "@t3tools/contracts";
import { type Cause, Effect, Option, Schema } from "effect";
import * as crypto from "node:crypto";
import * as nodePath from "node:path";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import type { ContinueTransferStoreShape } from "../git/continueTransferStore.ts";
import {
  continueLocalRefForTransfer,
  type ContinueTransportShape,
} from "../git/continueTransport.ts";
import { selectAutoBootstrapModelSelection } from "../provider/autoBootstrapModelSelection.ts";
import { systemCommandOrigin } from "./commandOrigin.ts";
import { buildContinueSeed, buildModelFallbackNote } from "./handoff.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

export const CONTINUE_ORIGIN_COMPONENT = "thread-continue";

/** How many `uno/continue/<id>-N` names `land` tries before giving up. */
const MAX_BRANCH_ATTEMPTS = 50;

export interface ContinueOnMachineDeps {
  readonly transport: ContinueTransportShape;
  readonly transfers: ContinueTransferStoreShape;
  /** Where new worktrees go on this machine (`<baseDir>/worktrees`). */
  readonly worktreesDir: string;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    | "getThreadDetailById"
    | "getThreadShellById"
    | "getProjectShellById"
    | "getShellSnapshot"
    | "getFirstActiveThreadIdByProjectId"
  >;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  /** Harness snapshots on this machine; decides whether the source's model can run here. */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Friendly label of this machine, as shown in the machine switcher. */
  readonly getMachineLabel: Effect.Effect<string>;
  /** `.env` in a folder as text; null when absent or unreadable. */
  readonly readEnvFile: (folder: string) => Effect.Effect<string | null>;
  readonly writeEnvFile: (folder: string, text: string) => Effect.Effect<void, Error>;
  readonly cloneRepository: (input: {
    readonly remoteUrl: string;
    readonly destinationPath: string;
  }) => Effect.Effect<{ readonly cwd: string }, Error>;
  readonly directoryExists: (path: string) => Effect.Effect<boolean>;
  readonly makeDirectory: (path: string) => Effect.Effect<void, Cause.UnknownError>;
  /** `~` expansion for paths the client typed or derived. */
  readonly expandPath: (path: string) => string;
  readonly now?: () => string;
  readonly newTransferId?: () => string;
}

/** Git-safe tail for `uno/continue/<tail>` from a thread or transfer id. */
function branchTail(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 12)
    .replace(/[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "chat";
}

/** Branch name for attempt `attempt` (1-based): `uno/continue/<id>`, then `-2`, `-3`, … */
export function continueBranchName(id: string, attempt = 1): string {
  const base = `${THREAD_CONTINUE_BRANCH_PREFIX}${branchTail(id)}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

const commandId = (tag: string) =>
  CommandId.make(`server:thread-continue:${tag}:${crypto.randomUUID()}`);

function errorDetail(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    if ("detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0) {
      return cause.detail;
    }
    if ("message" in cause && typeof cause.message === "string" && cause.message.length > 0) {
      return cause.message;
    }
  }
  return String(cause);
}

const fail = (reason: ThreadContinueErrorReason, message: string, cause?: unknown) =>
  new ThreadContinueError({
    message,
    reason,
    ...(cause !== undefined ? { cause } : {}),
  });

const isThreadContinueError = Schema.is(ThreadContinueError);

const mapFailure =
  (reason: ThreadContinueErrorReason, prefix: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ThreadContinueError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        isThreadContinueError(cause)
          ? cause
          : fail(reason, `${prefix}: ${errorDetail(cause)}`, cause),
      ),
    );

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) {
    return trimmed;
  }
  return trimmed.replace(/[/\\]+$/g, "");
}

function providerCanRun(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
): selection is ModelSelection {
  if (!selection) {
    return false;
  }
  return providers.some(
    (provider) =>
      provider.instanceId === selection.instanceId &&
      provider.installed &&
      provider.enabled &&
      isProviderAvailable(provider),
  );
}

/**
 * Which model the continued thread runs on here: the source's pick when that
 * harness is installed, otherwise the project's default, otherwise whatever
 * the machine can run. `fallbackApplied` drives the note in the seed.
 */
export function resolveTargetModelSelection(input: {
  readonly requested: ModelSelection | undefined;
  readonly projectDefault: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): { readonly selection: ModelSelection; readonly fallbackApplied: boolean } | null {
  if (providerCanRun(input.providers, input.requested)) {
    return { selection: input.requested, fallbackApplied: false };
  }
  const fallback = providerCanRun(input.providers, input.projectDefault)
    ? input.projectDefault
    : selectAutoBootstrapModelSelection(input.providers);
  if (fallback === null) {
    return null;
  }
  return { selection: fallback, fallbackApplied: input.requested !== undefined };
}

/**
 * Read-only look at where the chat would land on this machine, so the dialog
 * can say up front whether the project is there or will be added.
 */
export function makeThreadContinueInspect(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueInspectInput,
  ): Effect.Effect<ThreadContinueInspectResult, ThreadContinueError> =>
    Effect.gen(function* () {
      // Same expansion and trailing-slash handling as `land`, so the folder
      // inspected is the folder used.
      const projectPath = normalizePath(deps.expandPath(input.projectPath));
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(mapFailure("project_not_found", "Could not list the projects on this machine"));
      const registered = findProjectByPath(snapshot.projects, projectPath) !== undefined;
      const absent: ThreadContinueInspectResult = {
        projectPath,
        exists: false,
        isGitRepository: false,
        registered,
        hasLocalChanges: false,
        changedFiles: 0,
        branch: null,
      };

      const exists = yield* deps.directoryExists(projectPath);
      if (!exists) {
        return absent;
      }
      const isGit = yield* deps.transport
        .isGitRepository(projectPath)
        .pipe(mapFailure("not_git", "Could not inspect the project folder"));
      if (!isGit) {
        return { ...absent, exists: true };
      }
      const status = yield* deps.transport
        .readStatus(projectPath)
        .pipe(mapFailure("not_git", "Could not read the project's git status"));
      return {
        projectPath,
        exists: true,
        isGitRepository: true,
        registered,
        hasLocalChanges: status.changedFiles > 0,
        changedFiles: status.changedFiles,
        branch: status.branch,
      } satisfies ThreadContinueInspectResult;
    });
}

/** The folder a thread's files live in on this machine. */
function resolveSourceCwd(
  deps: ContinueOnMachineDeps,
  threadId: ThreadId,
): Effect.Effect<
  {
    readonly thread: OrchestrationThread;
    readonly project: OrchestrationProjectShell;
    readonly cwd: string;
  },
  ThreadContinueError
> {
  return Effect.gen(function* () {
    const thread = yield* deps.projections
      .getThreadDetailById(threadId)
      .pipe(mapFailure("thread_not_found", "Could not read the chat"));
    if (Option.isNone(thread)) {
      return yield* fail("thread_not_found", "This chat no longer exists on this machine.");
    }
    const project = yield* deps.projections
      .getProjectShellById(thread.value.projectId)
      .pipe(mapFailure("project_not_found", "Could not read the project"));
    if (Option.isNone(project)) {
      return yield* fail("project_not_found", "The project of this chat no longer exists.");
    }
    const cwd = resolveThreadWorkspaceCwd({ thread: thread.value, projects: [project.value] });
    if (!cwd) {
      return yield* fail("project_not_found", "This chat has no project folder to carry over.");
    }
    return { thread: thread.value, project: project.value, cwd };
  });
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * Source side: snapshot the thread's working tree into a bundle in the
 * scratch folder. Only the commits no remote-tracking branch has travel, plus
 * the snapshot itself; nothing is pushed anywhere.
 */
export function makeThreadContinueSnapshot(deps: ContinueOnMachineDeps) {
  const newTransferId = deps.newTransferId ?? (() => crypto.randomUUID());
  return (
    input: ThreadContinueSnapshotInput,
  ): Effect.Effect<ThreadContinueSnapshotResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const { thread, project, cwd } = yield* resolveSourceCwd(deps, input.threadId);
      const isGit = yield* deps.transport
        .isGitRepository(cwd)
        .pipe(mapFailure("not_git", "Could not inspect the project folder"));
      if (!isGit) {
        return yield* fail(
          "not_git",
          "This project is not a git repository. Uno Work packs the files for the other machine with git, so run `git init` in the project first.",
        );
      }
      yield* deps.transfers.sweep;

      const transferId = newTransferId();
      const head = yield* deps.transport
        .readHead(cwd)
        .pipe(mapFailure("capture_failed", "Could not read the current commit"));
      const ref = continueLocalRefForTransfer(transferId);
      const commit = yield* deps.transport
        .captureSnapshot({
          cwd,
          ref,
          parents: head.commit ? [head.commit] : [],
          message: `uno continue: ${thread.title}`,
        })
        .pipe(mapFailure("capture_failed", "Could not save the working tree"));

      const bundlePath = yield* deps.transfers.prepareOutgoing(transferId);
      // The hidden ref only exists to name the snapshot inside the bundle.
      yield* deps.transport
        .createBundle({ cwd, ref, bundlePath })
        .pipe(
          mapFailure("capture_failed", "Could not pack the files"),
          Effect.ensuring(deps.transport.deleteRef({ cwd, ref }).pipe(Effect.ignore)),
        );
      const digest = yield* deps.transfers
        .digest("outgoing", transferId)
        .pipe(Effect.tapError(() => deps.transfers.discard(transferId)));
      if (digest.sizeBytes > THREAD_CONTINUE_MAX_BUNDLE_BYTES) {
        yield* deps.transfers.discard(transferId);
        return yield* fail(
          "too_large",
          `The files to carry over are ${megabytes(digest.sizeBytes)}; one transfer can carry up to ${megabytes(THREAD_CONTINUE_MAX_BUNDLE_BYTES)}. Commit and push large files, or add them to .gitignore, then try again.`,
        );
      }

      // Only ever used by a target that has to clone the project; never pushed to.
      const remote = yield* deps.transport
        .resolveRemote(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const sourceMachineLabel = yield* deps.getMachineLabel;
      const seedText = buildContinueSeed({
        thread,
        sourceMachineLabel,
        sourceBranch: head.branch,
      });
      let envText: string | null = null;
      if (input.includeEnv === true) {
        envText = yield* deps.readEnvFile(cwd);
        if (envText === null && normalizePath(cwd) !== normalizePath(project.workspaceRoot)) {
          envText = yield* deps.readEnvFile(project.workspaceRoot);
        }
      }

      yield* Effect.logInfo("thread.continue.snapshot", {
        threadId: thread.id,
        transferId,
        commit,
        baseCommit: head.commit,
        sizeBytes: digest.sizeBytes,
        envIncluded: envText !== null,
      });

      return {
        transferId,
        sourceThreadId: thread.id,
        sourceMachineLabel,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        chunkBytes: THREAD_CONTINUE_CHUNK_BYTES,
        chunkCount: Math.max(1, Math.ceil(digest.sizeBytes / THREAD_CONTINUE_CHUNK_BYTES)),
        commit,
        baseCommit: head.commit,
        sourceBranch: head.branch,
        remoteUrl: remote?.url ?? null,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        seedText,
        envText,
      } satisfies ThreadContinueSnapshotResult;
    });
}

export function makeThreadContinueReadChunk(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueReadChunkInput,
  ): Effect.Effect<ThreadContinueReadChunkResult, ThreadContinueError> =>
    deps.transfers
      .readChunk({ transferId: input.transferId, index: input.index })
      .pipe(Effect.map((data) => ({ data })));
}

export function makeThreadContinueWriteChunk(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueWriteChunkInput,
  ): Effect.Effect<ThreadContinueWriteChunkResult, ThreadContinueError> =>
    deps.transfers
      .writeChunk({ transferId: input.transferId, offset: input.offset, data: input.data })
      .pipe(Effect.map((receivedBytes) => ({ receivedBytes })));
}

export function makeThreadContinueDiscard(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueDiscardInput,
  ): Effect.Effect<ThreadContinueDiscardResult, ThreadContinueError> =>
    deps.transfers.discard(input.transferId).pipe(Effect.map((removed) => ({ removed })));
}

interface ResolvedTargetProject {
  readonly project: OrchestrationProjectShell;
  readonly created: boolean;
}

function findProjectByPath(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  path: string,
): OrchestrationProjectShell | undefined {
  const wanted = normalizePath(path);
  return projects.find((project) => normalizePath(project.workspaceRoot) === wanted);
}

/**
 * The project the continued thread lands in. `existing` must already be
 * registered; `create` clones (or adopts a folder that is already a
 * repository, or starts an empty repository when the project has no remote)
 * and registers it, like "Move to a box" does.
 */
function resolveTargetProject(
  deps: ContinueOnMachineDeps,
  input: ThreadContinueLandInput,
  origin: ReturnType<typeof systemCommandOrigin>,
  createdAt: string,
): Effect.Effect<ResolvedTargetProject, ThreadContinueError> {
  return Effect.gen(function* () {
    const snapshot = yield* deps.projections
      .getShellSnapshot()
      .pipe(mapFailure("project_not_found", "Could not list the projects on this machine"));

    if (input.project.kind === "existing") {
      const projectPath = deps.expandPath(input.project.projectPath);
      const project = findProjectByPath(snapshot.projects, projectPath);
      if (!project) {
        return yield* fail(
          "project_not_found",
          `No project is registered at ${projectPath} on this machine.`,
        );
      }
      return { project, created: false };
    }

    const destination = deps.expandPath(input.project.destinationPath);
    const alreadyRegistered = findProjectByPath(snapshot.projects, destination);
    if (alreadyRegistered) {
      return { project: alreadyRegistered, created: false };
    }

    let cwd = destination;
    const exists = yield* deps.directoryExists(destination);
    if (exists) {
      const isGit = yield* deps.transport
        .isGitRepository(destination)
        .pipe(mapFailure("clone_failed", "Could not inspect the destination folder"));
      if (!isGit) {
        return yield* fail(
          "clone_failed",
          `${destination} already exists and is not a git repository. Remove it or pick another folder.`,
        );
      }
    } else if (input.project.remoteUrl !== null) {
      const cloned = yield* deps
        .cloneRepository({ remoteUrl: input.project.remoteUrl, destinationPath: destination })
        .pipe(
          mapFailure(
            "clone_failed",
            `Could not clone ${input.project.remoteUrl} here. Give this machine access to the repository or add the project to it first`,
          ),
        );
      cwd = cloned.cwd.trim().length > 0 ? cloned.cwd : destination;
    } else {
      // No remote anywhere: the bundle carries the whole history.
      yield* deps
        .makeDirectory(destination)
        .pipe(mapFailure("clone_failed", `Could not create ${destination}`));
      yield* deps.transport
        .initRepository(destination)
        .pipe(mapFailure("clone_failed", `Could not start a repository in ${destination}`));
    }

    const projectId = ProjectId.make(crypto.randomUUID());
    yield* deps.engine
      .dispatch(
        {
          type: "project.create",
          commandId: commandId("project-create"),
          projectId,
          title: input.project.title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          createdAt,
        },
        { origin },
      )
      .pipe(mapFailure("dispatch_failed", "Could not register the project"));
    const project = yield* deps.projections
      .getProjectShellById(projectId)
      .pipe(mapFailure("dispatch_failed", "Could not read the project after creating it"));
    if (Option.isNone(project)) {
      return yield* fail("dispatch_failed", "The project was created but cannot be read back.");
    }
    return { project: project.value, created: true };
  });
}

/** First `uno/continue/<id>[-N]` whose branch and worktree folder are both free. */
function pickWorktree(
  deps: ContinueOnMachineDeps,
  input: { readonly cwd: string; readonly id: string },
): Effect.Effect<{ readonly branch: string; readonly path: string }, ThreadContinueError> {
  return Effect.gen(function* () {
    const repoName = nodePath.basename(normalizePath(input.cwd)) || "project";
    for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
      const branch = continueBranchName(input.id, attempt);
      const path = nodePath.join(deps.worktreesDir, repoName, branch.replace(/\//g, "-"));
      const taken = yield* deps.transport
        .branchExists({ cwd: input.cwd, branch })
        .pipe(mapFailure("worktree_failed", "Could not list the branches"));
      if (taken) continue;
      if (yield* deps.directoryExists(path)) continue;
      return { branch, path };
    }
    return yield* fail(
      "worktree_failed",
      `Too many continued copies of this chat on this machine. Delete old ${THREAD_CONTINUE_BRANCH_PREFIX}* branches and try again.`,
    );
  });
}

/**
 * Target side: check the bundle that arrived, make sure the project exists,
 * open a new worktree on a new branch with the source's files, and create the
 * thread there. The person's own checkout of the project is not touched.
 */
export function makeThreadContinueLand(deps: ContinueOnMachineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return (
    input: ThreadContinueLandInput,
  ): Effect.Effect<ThreadContinueLandResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const createdAt = now();
      const origin = systemCommandOrigin(
        CONTINUE_ORIGIN_COMPONENT,
        `continued from ${input.sourceMachineLabel}`,
      );

      // 1. The bytes are exactly what the source packed.
      const digest = yield* deps.transfers.digest("incoming", input.transferId);
      if (digest.sizeBytes !== input.sizeBytes || digest.sha256 !== input.sha256) {
        return yield* fail(
          "transfer_incomplete",
          `The files did not arrive intact (${digest.sizeBytes} of ${input.sizeBytes} bytes). Try again.`,
        );
      }
      const bundlePath = yield* deps.transfers.incomingPath(input.transferId);

      // 2. The project, and a model that can run here, before any git write,
      //    so a refusal leaves no stray branch behind.
      const target = yield* resolveTargetProject(deps, input, origin, createdAt);
      const cwd = target.project.workspaceRoot;
      const isGit = yield* deps.transport
        .isGitRepository(cwd)
        .pipe(mapFailure("not_git", "Could not inspect the project folder"));
      if (!isGit) {
        return yield* fail(
          "not_git",
          `The project at ${cwd} is not a git repository on this machine, so the files cannot be added to it.`,
        );
      }
      const providers = yield* deps.getProviders;
      const model = resolveTargetModelSelection({
        requested: input.modelSelection,
        projectDefault: target.project.defaultModelSelection,
        providers,
      });
      if (model === null) {
        return yield* fail(
          "no_model",
          "No coding harness is installed and signed in on this machine yet. Set one up in Settings, then try again.",
        );
      }

      // 3. The commits the changes build on. Fetching from this machine's own
      //    remotes is fine (it only reads); nothing is ever pushed.
      let check = yield* deps.transport
        .verifyBundle({ cwd, bundlePath })
        .pipe(mapFailure("fetch_failed", "Could not read the transferred files"));
      if (!check.ok) {
        yield* deps.transport.fetchRemotes(cwd).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("thread.continue.land: fetch from remotes failed", {
              cwd,
              detail: errorDetail(cause),
            }),
          ),
        );
        check = yield* deps.transport
          .verifyBundle({ cwd, bundlePath })
          .pipe(mapFailure("fetch_failed", "Could not read the transferred files"));
      }
      if (!check.ok) {
        const base = input.baseCommit ? ` (${input.baseCommit.slice(0, 7)})` : "";
        yield* Effect.logWarning("thread.continue.land: bundle prerequisites missing", {
          cwd,
          detail: check.detail,
        });
        return yield* fail(
          "base_missing",
          `This machine does not have the commit the changes are based on${base} and could not fetch it from the project's remotes. Pull the latest commits into ${cwd} on this machine and try again.`,
        );
      }

      const ref = continueLocalRefForTransfer(input.transferId);
      const fetched = yield* deps.transport
        .fetchBundle({ cwd, bundlePath, ref })
        .pipe(mapFailure("fetch_failed", "Could not unpack the transferred files"));
      if (fetched !== input.commit) {
        yield* deps.transport.deleteRef({ cwd, ref }).pipe(Effect.ignore);
        return yield* fail(
          "commit_mismatch",
          `The transferred snapshot is ${fetched.slice(0, 7)}, not ${input.commit.slice(0, 7)} as the source reported. Try again from the source machine.`,
        );
      }

      // 4. A worktree of its own: new branch at the source's base commit, the
      //    snapshot's files on top as uncommitted changes.
      const worktree = yield* pickWorktree(deps, {
        cwd,
        id: input.sourceThreadId ?? input.transferId,
      });
      yield* deps.transport
        .addWorktree({
          cwd,
          branch: worktree.branch,
          path: worktree.path,
          // An unborn source has no base: the branch starts at the snapshot.
          startPoint: input.baseCommit ?? input.commit,
        })
        .pipe(
          mapFailure("worktree_failed", "Could not create a worktree for the chat"),
          Effect.tapError(() => deps.transport.deleteRef({ cwd, ref }).pipe(Effect.ignore)),
        );
      if (input.baseCommit !== null) {
        const restored = yield* deps.transport
          .restoreTree({ cwd: worktree.path, ref })
          .pipe(mapFailure("restore_failed", "Could not write the files into the worktree"));
        if (!restored) {
          return yield* fail("restore_failed", "The transferred snapshot is unavailable locally.");
        }
      }
      yield* deps.transport.deleteRef({ cwd, ref }).pipe(Effect.ignore);
      yield* deps.transfers.discard(input.transferId);

      let envWritten = false;
      if (typeof input.envText === "string") {
        envWritten = yield* deps.writeEnvFile(worktree.path, input.envText).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("thread.continue.land: .env not written", {
              worktreePath: worktree.path,
              detail: errorDetail(cause),
            }).pipe(Effect.as(false)),
          ),
        );
      }

      const seedText =
        model.fallbackApplied && input.modelSelection !== undefined
          ? [
              input.seedText,
              "",
              buildModelFallbackNote({
                sourceMachineLabel: input.sourceMachineLabel,
                requested: input.modelSelection,
                applied: model.selection,
              }),
            ].join("\n")
          : input.seedText;

      const threadId = ThreadId.make(crypto.randomUUID());
      const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
        deps.engine
          .dispatch(command, { origin })
          .pipe(mapFailure("dispatch_failed", `Could not create the chat (${command.type})`));

      yield* dispatch({
        type: "thread.create",
        commandId: commandId("thread-create"),
        threadId,
        projectId: target.project.id,
        title: input.title,
        modelSelection: model.selection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: worktree.branch,
        worktreePath: worktree.path,
        createdAt,
      });
      yield* dispatch({
        type: "thread.message.user.append",
        commandId: commandId("seed"),
        threadId,
        messageId: MessageId.make(crypto.randomUUID()),
        text: seedText,
        createdAt,
      });
      yield* dispatch({
        type: "thread.activity.append",
        commandId: commandId("continued-from"),
        threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: "thread.continued.from",
          summary: `Continued from ${input.sourceMachineLabel}`,
          payload: {
            sourceMachineLabel: input.sourceMachineLabel,
            sourceThreadId: input.sourceThreadId ?? null,
            branch: worktree.branch,
            worktreePath: worktree.path,
            commit: input.commit,
            baseCommit: input.baseCommit,
            envWritten,
            modelFallbackApplied: model.fallbackApplied,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });

      yield* Effect.logInfo("thread.continue.land", {
        threadId,
        projectId: target.project.id,
        projectCreated: target.created,
        transferId: input.transferId,
        branch: worktree.branch,
        worktreePath: worktree.path,
        commit: input.commit,
        envWritten,
        modelFallbackApplied: model.fallbackApplied,
      });

      return {
        projectId: target.project.id,
        threadId,
        projectPath: cwd,
        worktreePath: worktree.path,
        branch: worktree.branch,
        projectCreated: target.created,
        modelSelection: model.selection,
        modelFallbackApplied: model.fallbackApplied,
        envWritten,
      } satisfies ThreadContinueLandResult;
    });
}

/**
 * Answer for the 0.0.53–0.0.56 RPCs (`prepare` / `receive` / `cleanup`),
 * which pushed work in progress to `origin`. A current daemon never does
 * that, so an old client gets a readable request to update instead.
 */
export function makeThreadContinueLegacyRefusal(method: string) {
  return (_input: unknown): Effect.Effect<never, ThreadContinueError> =>
    Effect.logWarning("thread.continue: refused a request from an outdated client", {
      method,
    }).pipe(
      Effect.andThen(Effect.fail(fail("invalid_request", THREAD_CONTINUE_LEGACY_CLIENT_MESSAGE))),
    );
}

export function makeThreadContinueComplete(deps: ContinueOnMachineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return (
    input: ThreadContinueCompleteInput,
  ): Effect.Effect<ThreadContinueCompleteResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const createdAt = now();
      const thread = yield* deps.projections
        .getThreadShellById(input.threadId)
        .pipe(mapFailure("thread_not_found", "Could not read the chat"));
      if (Option.isNone(thread)) {
        return yield* fail("thread_not_found", "This chat no longer exists on this machine.");
      }
      const origin = systemCommandOrigin(
        CONTINUE_ORIGIN_COMPONENT,
        `continued on ${input.targetMachineLabel}`,
      );
      yield* deps.engine
        .dispatch(
          {
            type: "thread.activity.append",
            commandId: commandId("continued-on"),
            threadId: input.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "info",
              kind: "thread.continued.on",
              summary: `Continued on ${input.targetMachineLabel} as ${input.targetThreadId}`,
              payload: {
                targetMachineLabel: input.targetMachineLabel,
                targetThreadId: input.targetThreadId,
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          },
          { origin },
        )
        .pipe(mapFailure("dispatch_failed", "Could not mark the chat as continued"));

      let archived = false;
      const running =
        thread.value.session?.status === "running" && thread.value.session.activeTurnId != null;
      if (input.archive === true && !running) {
        yield* deps.engine
          .dispatch(
            { type: "thread.archive", commandId: commandId("archive"), threadId: input.threadId },
            { origin },
          )
          .pipe(mapFailure("dispatch_failed", "Could not archive the chat"));
        archived = true;
      }
      return { archived } satisfies ThreadContinueCompleteResult;
    });
}
