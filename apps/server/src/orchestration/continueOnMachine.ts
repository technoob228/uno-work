/**
 * "Continue on <machine>" — the RPC handlers.
 *
 * `prepare` runs on the daemon the chat lives on, `receive` on the daemon it
 * moves to, `cleanup` and `complete` on the source again; `inspect` is the
 * read-only look at the target before anything runs. The web client
 * sequences them; see `packages/contracts/src/threadContinue.ts`.
 *
 * Dependencies are passed explicitly (same pattern as `plugins/panelThread.ts`)
 * so the handlers are testable with a fake transport and fake projections,
 * and `ws.ts` stays a thin wiring layer. The git side lives in
 * `git/continueTransport.ts`; the seed text in `handoff.ts`.
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
  ThreadContinueError,
  type ThreadContinueErrorReason,
  type ThreadContinueCleanupInput,
  type ThreadContinueCleanupResult,
  type ThreadContinueCompleteInput,
  type ThreadContinueCompleteResult,
  type ThreadContinueInspectInput,
  type ThreadContinueInspectResult,
  type ThreadContinuePrepareInput,
  type ThreadContinuePrepareResult,
  type ThreadContinueReceiveInput,
  type ThreadContinueReceiveResult,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import * as crypto from "node:crypto";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import {
  continueLocalRefForThread,
  type ContinueTransportShape,
} from "../git/continueTransport.ts";
import { selectAutoBootstrapModelSelection } from "../provider/autoBootstrapModelSelection.ts";
import { systemCommandOrigin } from "./commandOrigin.ts";
import { buildContinueSeed, buildModelFallbackNote } from "./handoff.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

export const CONTINUE_ORIGIN_COMPONENT = "thread-continue";

/** Message the person sees when the project cannot travel because git has nowhere to push. */
export const NO_REMOTE_MESSAGE =
  "Add a git remote (GitHub or Uno Git) to continue on another machine.";

export interface ContinueOnMachineDeps {
  readonly transport: ContinueTransportShape;
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
  /** Root `.env` of a project as text; null when absent or unreadable. */
  readonly readEnvFile: (projectRoot: string) => Effect.Effect<string | null>;
  readonly writeEnvFile: (projectRoot: string, text: string) => Effect.Effect<void, Error>;
  readonly cloneRepository: (input: {
    readonly remoteUrl: string;
    readonly destinationPath: string;
  }) => Effect.Effect<{ readonly cwd: string }, Error>;
  readonly directoryExists: (path: string) => Effect.Effect<boolean>;
  /** `~` expansion for paths the client typed or derived. */
  readonly expandPath: (path: string) => string;
  readonly now?: () => string;
}

export function continueBranchForThread(threadId: string): string {
  return `${THREAD_CONTINUE_BRANCH_PREFIX}${threadId}`;
}

/** The thread id a transport branch was made for, or null when it is not one of ours. */
export function threadIdFromContinueBranch(branch: string): string | null {
  if (!branch.startsWith(THREAD_CONTINUE_BRANCH_PREFIX)) {
    return null;
  }
  const tail = branch.slice(THREAD_CONTINUE_BRANCH_PREFIX.length);
  return tail.length > 0 ? tail : null;
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
 * can say up front whether `receive` would overwrite uncommitted work.
 */
export function makeThreadContinueInspect(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueInspectInput,
  ): Effect.Effect<ThreadContinueInspectResult, ThreadContinueError> =>
    Effect.gen(function* () {
      // Same expansion and trailing-slash handling as `receive`, so the
      // folder inspected is the folder written to.
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

/** The folder a thread's files live in on this machine, with the errors `prepare`/`cleanup` share. */
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

export function makeThreadContinuePrepare(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinuePrepareInput,
  ): Effect.Effect<ThreadContinuePrepareResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const { thread, project, cwd } = yield* resolveSourceCwd(deps, input.threadId);
      const isGit = yield* deps.transport
        .isGitRepository(cwd)
        .pipe(mapFailure("not_git", "Could not inspect the project folder"));
      if (!isGit) {
        return yield* fail(
          "not_git",
          "This project is not a git repository. Git is how files travel between machines, so run `git init` and add a remote first.",
        );
      }
      const remote = yield* deps.transport
        .resolveRemote(cwd, input.remote ?? null)
        .pipe(mapFailure("no_remote", "Could not read the git remotes"));
      if (remote === null) {
        return yield* fail("no_remote", NO_REMOTE_MESSAGE);
      }

      const head = yield* deps.transport
        .readHead(cwd)
        .pipe(mapFailure("capture_failed", "Could not read the current commit"));
      const localRef = continueLocalRefForThread(thread.id);
      const commit = yield* deps.transport
        .captureSnapshot({
          cwd,
          ref: localRef,
          parents: head.commit ? [head.commit] : [],
          message: `uno continue: ${thread.title}`,
        })
        .pipe(mapFailure("capture_failed", "Could not save the working tree"));

      // A branch of the same name may already sit on the remote (an earlier
      // attempt for this chat, or a retry): the push is a force-update, so it
      // is reused rather than refused.
      const branch = continueBranchForThread(thread.id);
      yield* deps.transport
        .pushRef({ cwd, remoteName: remote.name, localRef, remoteBranch: branch })
        .pipe(mapFailure("push_failed", `Could not push to ${remote.name}`));
      // The remote holds the snapshot now; the hidden local ref is only clutter.
      yield* deps.transport.deleteRef({ cwd, ref: localRef }).pipe(Effect.ignore);

      const sourceMachineLabel = yield* deps.getMachineLabel;
      const seedText = buildContinueSeed({
        thread: thread,
        sourceMachineLabel,
        sourceBranch: head.branch,
      });
      const envText =
        input.includeEnv === false ? null : yield* deps.readEnvFile(project.workspaceRoot);

      yield* Effect.logInfo("thread.continue.prepare", {
        threadId: thread.id,
        remote: remote.name,
        branch,
        commit,
        baseCommit: head.commit,
        envIncluded: envText !== null,
      });

      return {
        sourceThreadId: thread.id,
        sourceMachineLabel,
        remoteUrl: remote.url,
        remoteName: remote.name,
        branch,
        commit,
        baseCommit: head.commit,
        sourceBranch: head.branch,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        seedText,
        envText,
      } satisfies ThreadContinuePrepareResult;
    });
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
 * registered; `create` clones (or adopts a folder that is already a clone)
 * and registers it, like "Move to a box" does.
 */
function resolveTargetProject(
  deps: ContinueOnMachineDeps,
  input: ThreadContinueReceiveInput,
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
    } else {
      const cloned = yield* deps
        .cloneRepository({ remoteUrl: input.project.remoteUrl, destinationPath: destination })
        .pipe(mapFailure("clone_failed", "Could not clone the repository"));
      cwd = cloned.cwd.trim().length > 0 ? cloned.cwd : destination;
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

export function makeThreadContinueReceive(deps: ContinueOnMachineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return (
    input: ThreadContinueReceiveInput,
  ): Effect.Effect<ThreadContinueReceiveResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const createdAt = now();
      const origin = systemCommandOrigin(
        CONTINUE_ORIGIN_COMPONENT,
        `continued from ${input.sourceMachineLabel}`,
      );
      const target = yield* resolveTargetProject(deps, input, origin, createdAt);
      const cwd = target.project.workspaceRoot;

      const refTail = threadIdFromContinueBranch(input.branch) ?? input.commit;
      const localRef = continueLocalRefForThread(refTail);
      const fetched = yield* deps.transport
        .fetchBranch({
          cwd,
          remoteUrl: input.remoteUrl,
          remoteBranch: input.branch,
          localRef,
        })
        .pipe(mapFailure("fetch_failed", `Could not fetch ${input.branch}`));
      if (fetched !== input.commit) {
        return yield* fail(
          "commit_mismatch",
          `The transport branch on the remote points at ${fetched.slice(0, 7)}, not the snapshot that was just pushed (${input.commit.slice(0, 7)}). Try again from the source machine.`,
        );
      }
      const restored = yield* deps.transport
        .restoreTree({ cwd, ref: localRef })
        .pipe(mapFailure("restore_failed", "Could not write the files into the project"));
      if (!restored) {
        return yield* fail("restore_failed", "The fetched snapshot is unavailable locally.");
      }
      yield* deps.transport.deleteRef({ cwd, ref: localRef }).pipe(Effect.ignore);

      let envWritten = false;
      if (typeof input.envText === "string") {
        envWritten = yield* deps.writeEnvFile(cwd, input.envText).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("thread.continue.receive: .env not written", {
              cwd,
              detail: errorDetail(cause),
            }).pipe(Effect.as(false)),
          ),
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
        branch: null,
        worktreePath: null,
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
            branch: input.branch,
            commit: input.commit,
            envWritten,
            modelFallbackApplied: model.fallbackApplied,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });

      yield* Effect.logInfo("thread.continue.receive", {
        threadId,
        projectId: target.project.id,
        projectCreated: target.created,
        branch: input.branch,
        commit: input.commit,
        envWritten,
        modelFallbackApplied: model.fallbackApplied,
      });

      return {
        projectId: target.project.id,
        threadId,
        projectPath: cwd,
        projectCreated: target.created,
        modelSelection: model.selection,
        modelFallbackApplied: model.fallbackApplied,
        envWritten,
      } satisfies ThreadContinueReceiveResult;
    });
}

/**
 * Deletes the transport branch on the remote once the target has fetched it.
 * Best-effort by design: a failure here must never undo a handoff that
 * already succeeded, so it is logged and reported as `removed: false`.
 * Missing chat or project still fail, since there is nothing to clean.
 */
export function makeThreadContinueCleanup(deps: ContinueOnMachineDeps) {
  return (
    input: ThreadContinueCleanupInput,
  ): Effect.Effect<ThreadContinueCleanupResult, ThreadContinueError> =>
    Effect.gen(function* () {
      const source = yield* resolveSourceCwd(deps, input.threadId);
      const branch = continueBranchForThread(source.thread.id);
      const logSkip = (detail: string) =>
        Effect.logWarning("thread.continue.cleanup: transport branch not removed", {
          threadId: source.thread.id,
          branch,
          detail,
        }).pipe(Effect.as({ branch, removed: false } satisfies ThreadContinueCleanupResult));

      const remote = yield* deps.transport
        .resolveRemote(source.cwd, input.remote ?? null)
        .pipe(Effect.catch((cause) => Effect.succeed({ error: errorDetail(cause) })));
      if (remote === null) {
        return yield* logSkip("no remote");
      }
      if ("error" in remote) {
        return yield* logSkip(remote.error);
      }
      return yield* deps.transport
        .deleteRemoteBranch({ cwd: source.cwd, remoteName: remote.name, remoteBranch: branch })
        .pipe(
          Effect.andThen(
            Effect.logInfo("thread.continue.cleanup", {
              threadId: source.thread.id,
              remote: remote.name,
              branch,
            }),
          ),
          Effect.as({ branch, removed: true } satisfies ThreadContinueCleanupResult),
          Effect.catch((cause) => logSkip(errorDetail(cause))),
        );
    });
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
