/**
 * "Continue on <machine>" — carry one chat (files + history, and secrets
 * only when asked) from the daemon it lives on to another daemon.
 *
 * Files never leave through a git remote. The source daemon snapshots the
 * thread's working tree (tracked + untracked, not ignored) into a commit on a
 * hidden ref and packs it into a git bundle in its scratch directory. The web
 * client — which is already authenticated to both daemons — reads the bundle
 * from the source in chunks and writes the same chunks to the target. The
 * target verifies size and SHA-256, fetches the bundle into its own copy of
 * the repository and opens the chat in a NEW worktree on a new branch
 * `uno/continue/<id>`, so the checkout the person already has there is never
 * touched.
 *
 * The bundle carries only what the target cannot get on its own: commits
 * that are not on any remote-tracking branch of the source, plus the
 * snapshot. When the target lacks the base commit it may *fetch* it from its
 * own remotes (reading is fine); nothing is ever pushed.
 *
 * RPCs:
 *
 * - `thread.continue.inspect` (TARGET, read-only): does the project folder
 *   exist there and is it a git checkout.
 * - `thread.continue.snapshot` (SOURCE): snapshot + bundle; returns a
 *   `transferId`, the bundle's size and hash, thread settings and the handoff
 *   seed. `.env` is included only with `includeEnv: true`.
 * - `thread.continue.readChunk` (SOURCE) / `thread.continue.writeChunk`
 *   (TARGET): move the bundle through the client.
 * - `thread.continue.land` (TARGET): verify, fetch, create the worktree and
 *   the new thread.
 * - `thread.continue.discard` (either side, best-effort): delete a bundle.
 * - `thread.continue.complete` (SOURCE): mark the old thread, optionally
 *   archive it.
 *
 * Daemons that speak this protocol advertise `threadContinueDirect` in their
 * environment descriptor; the client refuses to start without it on both
 * sides. `prepare` / `receive` / `cleanup` are the 0.0.53–0.0.56 protocol that
 * pushed through `origin`; they stay registered only so an old client gets a
 * readable "update" error instead of an unknown-method defect.
 */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/** Prefix of the branch the continued chat gets on the target: `uno/continue/<id>`. */
export const THREAD_CONTINUE_BRANCH_PREFIX = "uno/continue/";

/** Raw bytes per `readChunk` / `writeChunk` call (base64 on the wire ≈ 2.7 MiB). */
export const THREAD_CONTINUE_CHUNK_BYTES = 2 * 1024 * 1024;

/** Largest bundle either side accepts. Ignored files (node_modules, build output) never count. */
export const THREAD_CONTINUE_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

export const ThreadContinueErrorReason = Schema.Literals([
  "thread_not_found",
  "project_not_found",
  "not_git",
  /** Legacy (0.0.53–0.0.56): the old protocol refused projects without a remote. */
  "no_remote",
  "capture_failed",
  /** Legacy (0.0.53–0.0.56). */
  "push_failed",
  "clone_failed",
  "fetch_failed",
  "commit_mismatch",
  "restore_failed",
  "no_model",
  "dispatch_failed",
  "invalid_request",
  /** The snapshot is bigger than `THREAD_CONTINUE_MAX_BUNDLE_BYTES`. */
  "too_large",
  /** No bundle with that transfer id on this machine (expired or never written). */
  "transfer_not_found",
  /** The bytes that arrived do not match the size or hash the source reported. */
  "transfer_incomplete",
  /** The target does not have the commit the changes are based on and could not fetch it. */
  "base_missing",
  "worktree_failed",
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

/** Transfer ids are UUIDs minted by the source; anything else is refused before touching disk. */
export const ThreadContinueTransferId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
export type ThreadContinueTransferId = typeof ThreadContinueTransferId.Type;

// ── inspect (target, read-only) ─────────────────────────────────────────

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
  /** The folder is a git checkout; `land` refuses a folder that exists but is not one. */
  isGitRepository: Schema.Boolean,
  /** A project is registered at this path on this machine. */
  registered: Schema.Boolean,
  /**
   * Uncommitted or untracked work in that checkout. Informational only: the
   * chat lands in its own worktree and never touches these files. (Kept in
   * the schema for clients from 0.0.53–0.0.56, which warn about it.)
   */
  hasLocalChanges: Schema.Boolean,
  /** Number of changed entries in `git status` (tracked changes plus untracked files). */
  changedFiles: Schema.Number,
  /** Branch the checkout is on; null when detached, unborn or not a repository. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadContinueInspectResult = typeof ThreadContinueInspectResult.Type;

// ── snapshot (source) ───────────────────────────────────────────────────

export const ThreadContinueSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Read `.env` (from the thread's worktree, else the project root) and
   * return it as `envText`. Off unless the person ticked the box.
   */
  includeEnv: Schema.optional(Schema.Boolean),
});
export type ThreadContinueSnapshotInput = typeof ThreadContinueSnapshotInput.Type;

export const ThreadContinueSnapshotResult = Schema.Struct({
  transferId: ThreadContinueTransferId,
  sourceThreadId: ThreadId,
  sourceMachineLabel: TrimmedNonEmptyString,
  /** Size of the bundle in bytes. */
  sizeBytes: Schema.Number,
  /** Hex SHA-256 of the whole bundle; the target refuses anything else. */
  sha256: TrimmedNonEmptyString,
  /** Bytes per chunk the source serves; the last chunk may be shorter. */
  chunkBytes: Schema.Number,
  chunkCount: Schema.Number,
  /** The snapshot commit inside the bundle; the target verifies it after fetching. */
  commit: TrimmedNonEmptyString,
  /** HEAD of the source workspace when the snapshot was taken; null in an unborn repo. */
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** Branch the source workspace was on; null when detached or unborn. */
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Fetch URL of the project's primary remote, so a target without the
   * project can clone it. Null when the project has no remote. Never pushed to.
   */
  remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** First user message of the new thread: header + recent history. */
  seedText: TrimmedNonEmptyString,
  /** `.env` text; null when not requested or absent. */
  envText: Schema.NullOr(Schema.String),
});
export type ThreadContinueSnapshotResult = typeof ThreadContinueSnapshotResult.Type;

// ── chunks (source reads, target writes) ────────────────────────────────

export const ThreadContinueReadChunkInput = Schema.Struct({
  transferId: ThreadContinueTransferId,
  index: NonNegativeInt,
});
export type ThreadContinueReadChunkInput = typeof ThreadContinueReadChunkInput.Type;

export const ThreadContinueReadChunkResult = Schema.Struct({
  /** Base64 of the chunk's bytes. */
  data: Schema.String,
});
export type ThreadContinueReadChunkResult = typeof ThreadContinueReadChunkResult.Type;

export const ThreadContinueWriteChunkInput = Schema.Struct({
  transferId: ThreadContinueTransferId,
  /** Byte offset of this chunk. Offset 0 starts the file over, so a retried transfer is idempotent. */
  offset: NonNegativeInt,
  /** Base64 of the chunk's bytes. */
  data: Schema.String,
});
export type ThreadContinueWriteChunkInput = typeof ThreadContinueWriteChunkInput.Type;

export const ThreadContinueWriteChunkResult = Schema.Struct({
  /** Size of the incoming file after this write. */
  receivedBytes: Schema.Number,
});
export type ThreadContinueWriteChunkResult = typeof ThreadContinueWriteChunkResult.Type;

// ── land (target) ───────────────────────────────────────────────────────

/** Where the thread lands on the target: a project already registered there, or a fresh one. */
export const ThreadContinueLandProject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing"),
    /** Workspace root of the registered project on the target machine. */
    projectPath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    /** Clone from here (read-only). Null: start an empty repository and fill it from the bundle. */
    remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
    /** Absolute (or `~`-relative) path to clone into and register. */
    destinationPath: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
  }),
]);
export type ThreadContinueLandProject = typeof ThreadContinueLandProject.Type;

export const ThreadContinueLandInput = Schema.Struct({
  transferId: ThreadContinueTransferId,
  sizeBytes: Schema.Number,
  sha256: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  project: ThreadContinueLandProject,
  title: TrimmedNonEmptyString,
  /** Falls back to the target project's default when this harness is not installed there. */
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  seedText: TrimmedNonEmptyString,
  /** Written into the new worktree only; the target's own checkout keeps its `.env`. */
  envText: Schema.optional(Schema.NullOr(Schema.String)),
  sourceMachineLabel: TrimmedNonEmptyString,
  sourceThreadId: Schema.optional(ThreadId),
});
export type ThreadContinueLandInput = typeof ThreadContinueLandInput.Type;

export const ThreadContinueLandResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  projectPath: TrimmedNonEmptyString,
  /** The new worktree the chat runs in. */
  worktreePath: TrimmedNonEmptyString,
  /** The new branch checked out in that worktree (`uno/continue/…`). */
  branch: TrimmedNonEmptyString,
  /** True when the project was cloned (or created) and registered by this call. */
  projectCreated: Schema.Boolean,
  modelSelection: ModelSelection,
  /** True when the requested harness is not installed here and the project default was used. */
  modelFallbackApplied: Schema.Boolean,
  envWritten: Schema.Boolean,
});
export type ThreadContinueLandResult = typeof ThreadContinueLandResult.Type;

// ── discard (either side) ───────────────────────────────────────────────

export const ThreadContinueDiscardInput = Schema.Struct({
  transferId: ThreadContinueTransferId,
});
export type ThreadContinueDiscardInput = typeof ThreadContinueDiscardInput.Type;

export const ThreadContinueDiscardResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type ThreadContinueDiscardResult = typeof ThreadContinueDiscardResult.Type;

// ── complete (source) ───────────────────────────────────────────────────

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

// ── legacy protocol (0.0.53–0.0.56) ─────────────────────────────────────
//
// Pushed the snapshot to `uno/continue/<threadId>` on `origin`. Current
// daemons still decode these payloads but always answer with an
// `invalid_request` error asking to update the app, so an old client never
// publishes work in progress through a daemon that no longer should.

/** @deprecated 0.0.53–0.0.56 protocol; the handler only returns an update error. */
export const ThreadContinuePrepareInput = Schema.Struct({
  threadId: ThreadId,
  remote: Schema.optional(TrimmedNonEmptyString),
  includeEnv: Schema.optional(Schema.Boolean),
});
export type ThreadContinuePrepareInput = typeof ThreadContinuePrepareInput.Type;

/** @deprecated 0.0.53–0.0.56 protocol. */
export const ThreadContinuePrepareResult = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceMachineLabel: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  seedText: TrimmedNonEmptyString,
  envText: Schema.NullOr(Schema.String),
});
export type ThreadContinuePrepareResult = typeof ThreadContinuePrepareResult.Type;

/** @deprecated 0.0.53–0.0.56 protocol. */
export const ThreadContinueReceiveInput = Schema.Struct({
  project: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("existing"), projectPath: TrimmedNonEmptyString }),
    Schema.Struct({
      kind: Schema.Literal("create"),
      remoteUrl: TrimmedNonEmptyString,
      destinationPath: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
    }),
  ]),
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  seedText: TrimmedNonEmptyString,
  envText: Schema.optional(Schema.NullOr(Schema.String)),
  sourceMachineLabel: TrimmedNonEmptyString,
  sourceThreadId: Schema.optional(ThreadId),
});
export type ThreadContinueReceiveInput = typeof ThreadContinueReceiveInput.Type;

/** @deprecated 0.0.53–0.0.56 protocol. */
export const ThreadContinueReceiveResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  projectPath: TrimmedNonEmptyString,
  projectCreated: Schema.Boolean,
  modelSelection: ModelSelection,
  modelFallbackApplied: Schema.Boolean,
  envWritten: Schema.Boolean,
});
export type ThreadContinueReceiveResult = typeof ThreadContinueReceiveResult.Type;

/** @deprecated 0.0.53–0.0.56 protocol. */
export const ThreadContinueCleanupInput = Schema.Struct({
  threadId: ThreadId,
  remote: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadContinueCleanupInput = typeof ThreadContinueCleanupInput.Type;

/** @deprecated 0.0.53–0.0.56 protocol. */
export const ThreadContinueCleanupResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  removed: Schema.Boolean,
});
export type ThreadContinueCleanupResult = typeof ThreadContinueCleanupResult.Type;

/** What a current daemon answers to the legacy RPCs. */
export const THREAD_CONTINUE_LEGACY_CLIENT_MESSAGE =
  "Update Uno Work on the device you are using. Continuing a chat on another machine now sends files directly between your machines instead of through GitHub, and this version of the app still uses the old way.";
