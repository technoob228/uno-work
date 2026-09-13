/**
 * "Continue on <machine>" — carry one chat (files + history + secrets) from
 * the daemon it lives on to another daemon.
 *
 * Three RPCs on the main path, two daemons, plus two small helpers:
 *
 * - `thread.continue.inspect` runs on the TARGET before anything happens. It
 *   is read-only: does the project folder exist there, is it a git checkout,
 *   which branch is it on and does it carry uncommitted work that `receive`
 *   would overwrite. The dialog uses it to warn before replacing files.
 * - `thread.continue.prepare` runs on the SOURCE. It snapshots the thread's
 *   workspace into a WIP commit on a transport branch, pushes it to the
 *   project's git remote and returns everything the target needs (branch,
 *   commit, thread settings, a handoff seed built from the chat history, and
 *   optionally the root `.env`).
 * - `thread.continue.receive` runs on the TARGET. It makes sure the project
 *   exists there (cloning it if needed), fetches the transport branch, puts
 *   its tree into the working tree without touching the target's branch, and
 *   creates the new thread with the seed as its first user message.
 * - `thread.continue.cleanup` runs on the SOURCE after a successful receive
 *   and deletes the transport branch on the remote. Best-effort: a failure is
 *   reported in the result, never thrown, so it cannot block the handoff.
 * - `thread.continue.complete` runs on the SOURCE again to mark the old
 *   thread ("Continued on <machine>") and optionally archive it.
 *
 * The web client orchestrates the three calls; the daemons never talk to each
 * other. A future per-project "Sync" can reuse prepare/receive as-is.
 */
import { Schema } from "effect";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/** Prefix of the transport branch on the remote: `uno/continue/<threadId>`. */
export const THREAD_CONTINUE_BRANCH_PREFIX = "uno/continue/";

export const ThreadContinueErrorReason = Schema.Literals([
  "thread_not_found",
  "project_not_found",
  "not_git",
  "no_remote",
  "capture_failed",
  "push_failed",
  "clone_failed",
  "fetch_failed",
  "commit_mismatch",
  "restore_failed",
  "no_model",
  "dispatch_failed",
  "invalid_request",
]);
export type ThreadContinueErrorReason = typeof ThreadContinueErrorReason.Type;

export class ThreadContinueError extends Schema.TaggedErrorClass<ThreadContinueError>()(
  "ThreadContinueError",
  {
    message: Schema.String,
    /** Machine-readable reason so the UI can pick wording without parsing prose. */
    reason: ThreadContinueErrorReason,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ThreadContinueInspectInput = Schema.Struct({
  /**
   * Folder the chat would land in on this machine: the workspace root of a
   * registered project, or the destination a fresh clone would go to. `~` is
   * expanded here.
   */
  projectPath: TrimmedNonEmptyString,
});
export type ThreadContinueInspectInput = typeof ThreadContinueInspectInput.Type;

export const ThreadContinueInspectResult = Schema.Struct({
  /** `projectPath` with `~` expanded, as the receiver would use it. */
  projectPath: TrimmedNonEmptyString,
  /** The folder exists on this machine. */
  exists: Schema.Boolean,
  /** The folder is a git checkout; `receive` refuses a folder that exists but is not one. */
  isGitRepository: Schema.Boolean,
  /** A project is registered at this path on this machine. */
  registered: Schema.Boolean,
  /** Uncommitted or untracked work that `receive` would replace. */
  hasLocalChanges: Schema.Boolean,
  /** Number of changed entries in `git status` (tracked changes plus untracked files). */
  changedFiles: Schema.Number,
  /** Branch the checkout is on; null when detached, unborn or not a repository. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadContinueInspectResult = typeof ThreadContinueInspectResult.Type;

export const ThreadContinuePrepareInput = Schema.Struct({
  threadId: ThreadId,
  /** Git remote to push the transport branch to; defaults to the project's primary remote (`origin`). */
  remote: Schema.optional(TrimmedNonEmptyString),
  /** Read the project's root `.env` and return it as `envText`. Defaults to true. */
  includeEnv: Schema.optional(Schema.Boolean),
});
export type ThreadContinuePrepareInput = typeof ThreadContinuePrepareInput.Type;

export const ThreadContinuePrepareResult = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceMachineLabel: TrimmedNonEmptyString,
  /** Fetch URL of the remote the transport branch was pushed to. */
  remoteUrl: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
  /** Branch name on the remote (without `refs/heads/`). */
  branch: TrimmedNonEmptyString,
  /** The WIP commit that was pushed; the receiver verifies it after fetching. */
  commit: TrimmedNonEmptyString,
  /** HEAD of the source workspace when the snapshot was taken; null in an unborn repo. */
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** Branch the source workspace was on; null when detached or unborn. */
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** First user message of the new thread: header + recent history. */
  seedText: TrimmedNonEmptyString,
  /** Root `.env` of the project; null when absent or not requested. */
  envText: Schema.NullOr(Schema.String),
});
export type ThreadContinuePrepareResult = typeof ThreadContinuePrepareResult.Type;

/** Where the thread lands on the target: a project already registered there, or a fresh clone. */
export const ThreadContinueReceiveProject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing"),
    /** Workspace root of the registered project on the target machine. */
    projectPath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    remoteUrl: TrimmedNonEmptyString,
    /** Absolute (or `~`-relative) path to clone into and register. */
    destinationPath: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
  }),
]);
export type ThreadContinueReceiveProject = typeof ThreadContinueReceiveProject.Type;

export const ThreadContinueReceiveInput = Schema.Struct({
  project: ThreadContinueReceiveProject,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  /** Falls back to the target project's default when this harness is not installed there. */
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  seedText: TrimmedNonEmptyString,
  envText: Schema.optional(Schema.NullOr(Schema.String)),
  sourceMachineLabel: TrimmedNonEmptyString,
  sourceThreadId: Schema.optional(ThreadId),
});
export type ThreadContinueReceiveInput = typeof ThreadContinueReceiveInput.Type;

export const ThreadContinueReceiveResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  projectPath: TrimmedNonEmptyString,
  /** True when the project was cloned and registered by this call. */
  projectCreated: Schema.Boolean,
  modelSelection: ModelSelection,
  /** True when the requested harness is not installed here and the project default was used. */
  modelFallbackApplied: Schema.Boolean,
  envWritten: Schema.Boolean,
});
export type ThreadContinueReceiveResult = typeof ThreadContinueReceiveResult.Type;

export const ThreadContinueCleanupInput = Schema.Struct({
  threadId: ThreadId,
  /** Remote the transport branch was pushed to (`remoteName` of the prepare result). */
  remote: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadContinueCleanupInput = typeof ThreadContinueCleanupInput.Type;

export const ThreadContinueCleanupResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  /** False when the branch could not be deleted; the reason is in the server log. */
  removed: Schema.Boolean,
});
export type ThreadContinueCleanupResult = typeof ThreadContinueCleanupResult.Type;

export const ThreadContinueCompleteInput = Schema.Struct({
  threadId: ThreadId,
  targetMachineLabel: TrimmedNonEmptyString,
  targetThreadId: ThreadId,
  /** Archive the source thread once the continuation exists. Defaults to false. */
  archive: Schema.optional(Schema.Boolean),
});
export type ThreadContinueCompleteInput = typeof ThreadContinueCompleteInput.Type;

export const ThreadContinueCompleteResult = Schema.Struct({
  archived: Schema.Boolean,
});
export type ThreadContinueCompleteResult = typeof ThreadContinueCompleteResult.Type;
