/**
 * Parallel chats in one project (spec: PARALLEL_CHATS.md, night wave 02.11).
 *
 * The first chat works in the project folder, as always. A chat that starts
 * while another one works in the folder quietly gets its own copy (a linked
 * worktree of the folder's hidden `.uno-git` repository) and stays in it.
 * When its turn ends, its work joins the folder by a three-way merge on the
 * folder's state — after the folder's own chat finished, never mid-turn.
 * Two chats that changed the same lines: the chat combines them itself in one
 * short turn; if both can't be true, it asks the person and the work waits in
 * the copy.
 *
 * Off (the default): no copy is made and no git runs for chats outside a
 * copy; copies made while it was on still join the folder.
 *
 * State: `refs/uno/parallel/<thread>/base` (the folder state the copy agrees
 * with), `…/conflict` (waiting to combine), the copy's path in the thread.
 * In memory only: which turns are starting and which copies wait to join;
 * both are rebuilt from the projection after a restart.
 *
 * @module parallelChats/ParallelChats
 */
import { existsSync } from "node:fs";
import * as os from "node:os";
import nodePath from "node:path";

import {
  CommandId,
  EventId,
  isAssistantProjectId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ParallelChatsMode,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  PARALLEL_CHATS_ACTIVITY_KIND,
  parallelChatsLine,
  parallelCopyAgentNote,
  parallelResolveNoteBody,
  type ParallelChatsLinePayload,
} from "@t3tools/shared/parallelChats";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { Context, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { diskSpaceAt } from "../files/diskSpace.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { claudeConfigDir } from "../provider/Drivers/claudeUnoCreditsMigration.ts";
import { instanceClaudeConfigDir } from "../provider/providerAccounts.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { isLowDisk } from "../worktreeCleanup/policy.ts";

import {
  copyClaudeTranscript,
  copyEnvFiles,
  linkNodeModules,
  processRunsIn,
} from "./parallelCopyContents.ts";
import {
  baseRefFor,
  conflictRefFor,
  copyAt,
  detectRepoKind,
  fileHasMarkers,
  indexEntryCount,
  makeParallelGit,
  rootAt,
  UNO_GIT_DIR,
  ParallelChatsError,
  type GitExec,
  type MergeConflict,
} from "./parallelGit.ts";
import {
  APPLY_ATTEMPTS,
  APPLY_RETRY_DELAY_MS,
  autoCopyPath,
  COPY_TIMEOUT_MS,
  copyLimitRefusal,
  decodeConflictRecord,
  effectiveParallelMode,
  encodeConflictRecord,
  isAutoCopyPath,
  isOwnAutoCopy,
  keptVersionName,
  parkedOtherAgentNote,
  projectIneligibleReason,
  sessionEndsTurn,
  sessionIsBusy,
  sessionMove,
  startingTurnClearedBy,
  STARTING_TURN_TTL_MS,
} from "./parallelRules.ts";

export const PARALLEL_CHATS_COMMAND_PREFIX = "parallel-chats:";
export const PARALLEL_CHATS_ORIGIN_COMPONENT = "parallel-chats";
/** Copies waiting to join are looked at again this often (a refused apply, a lost event). */
export const PARALLEL_TICK = Duration.seconds(60);
/** Idle copies whose work all joined are removed this often (they come back on the next message). */
export const IDLE_SWEEP_INTERVAL = Duration.hours(1);
export const IDLE_COPY_AFTER_MS = 24 * 60 * 60_000;

/** What a turn start needs from a thread (the reactor passes its full thread). */
export type ParallelThread = Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "worktreePath"
  | "branch"
  | "session"
  | "runtimeMode"
  | "interactionMode"
  | "latestTurn"
>;

export interface ParallelTurnStart<T extends ParallelThread> {
  /** The thread as the turn should run it (its folder may have changed). */
  readonly thread: T;
  /** Added to the agent's prompt (not to the stored message), or null. */
  readonly agentNote: string | null;
  /**
   * Another chat works in the folder and no copy could be made (disk, limits,
   * an agent that can't move): the turn must not start now. The reactor holds
   * it until `awaitFolderFree` and asks again; the chat already got its line.
   */
  readonly waitForFolder?: true;
}

/** How often a held turn start looks at the folder again. */
export const HELD_TURN_POLL = Duration.seconds(2);

export interface ParallelChatsShape {
  /** Called by the provider command reactor first thing for each turn start. Never fails. */
  readonly beforeTurn: <T extends ParallelThread>(thread: T) => Effect.Effect<ParallelTurnStart<T>>;
  /**
   * Done when no other chat works in the thread's project folder (or the flag
   * went off, or the thread is gone). Never fails.
   */
  readonly awaitFolderFree: (threadId: ThreadId) => Effect.Effect<void>;
  /** Event subscription and the periodic look at waiting copies. */
  readonly start: () => Effect.Effect<void, never, import("effect").Scope.Scope>;
  /** Try to join every waiting copy now (tests; the tick does the same). */
  readonly drainAll: Effect.Effect<void>;
}

export class ParallelChats extends Context.Service<ParallelChats, ParallelChatsShape>()(
  "t3/parallelChats/ParallelChats",
) {}

export interface ParallelChatsDeps {
  readonly worktreesDir: string;
  readonly tempDir: string;
  readonly home?: string;
  readonly git: GitExec;
  readonly mode: Effect.Effect<ParallelChatsMode>;
  readonly getProject: (projectId: ProjectId) => Effect.Effect<OrchestrationProjectShell | null>;
  readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | null>;
  /** All live (not deleted) threads. */
  readonly listThreads: Effect.Effect<ReadonlyArray<OrchestrationThreadShell>>;
  readonly dispatch: (
    command: OrchestrationCommand,
    origin?: { readonly component: string; readonly reason?: string },
  ) => Effect.Effect<void>;
  readonly domainEvents?: Stream.Stream<OrchestrationEvent>;
  /** The thread's saved agent session: its driver and the id it resumes with. */
  readonly sessionOf: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly driver: string | null; readonly resumeId: string | null } | null>;
  /** Claude Code config folders a transcript may be in. */
  readonly claudeConfigDirs: Effect.Effect<ReadonlyArray<string>>;
  readonly lowDisk: Effect.Effect<boolean>;
  readonly now?: () => number;
}

const commandId = (tag: string) =>
  CommandId.make(`${PARALLEL_CHATS_COMMAND_PREFIX}${tag}:${crypto.randomUUID()}`);

const sameFolder = (left: string, right: string) =>
  nodePath.resolve(left) === nodePath.resolve(right);

export const makeParallelChats = Effect.fn("makeParallelChats")(function* (
  deps: ParallelChatsDeps,
) {
  const git = makeParallelGit(deps.git);
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? Date.now;
  const lock = yield* Semaphore.make(1);
  const tempDir = nodePath.join(deps.tempDir, "parallel-chats");

  /** Turns started through `beforeTurn` whose session doesn't show "running" yet. */
  const starting = new Map<string, number>();
  /** Chats in a copy whose work may have to join the folder, oldest first. */
  const pending = new Map<string, number>();
  /** Chats already told "Joins the project when the other chat finishes." for this wait. */
  const toldWaiting = new Set<string>();
  /** Chats already told their turn waits for the folder, for this wait. */
  const toldQueued = new Set<string>();
  /** Chats already told their work waits for an answer, for this conflict. */
  const toldParked = new Set<string>();
  /** Where each chat's copy is and whose project it is: a deleted chat is gone from the projection. */
  const known = new Map<string, { readonly root: string; readonly copy: string }>();
  const remember = (
    thread: Pick<OrchestrationThreadShell, "id" | "worktreePath">,
    root: string,
  ) => {
    if (isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)) {
      known.set(thread.id, { root, copy: thread.worktreePath! });
    }
  };

  const isStarting = (threadId: string) => {
    const at = starting.get(threadId);
    if (at === undefined) return false;
    if (now() - at > STARTING_TURN_TTL_MS) {
      starting.delete(threadId);
      return false;
    }
    return true;
  };

  const threadBusy = (thread: Pick<OrchestrationThreadShell, "id" | "session">) =>
    isStarting(thread.id) || sessionIsBusy(thread.session?.status);

  const inFolder = (thread: Pick<OrchestrationThreadShell, "worktreePath">, root: string) =>
    thread.worktreePath === null || sameFolder(thread.worktreePath, root);

  const projectThreads = (projectId: ProjectId) =>
    deps.listThreads.pipe(
      Effect.map((threads) => threads.filter((thread) => thread.projectId === projectId)),
    );

  /** Another chat is working in the folder itself. */
  const folderBusy = (projectId: ProjectId, root: string, except: string | null) =>
    projectThreads(projectId).pipe(
      Effect.map((threads) =>
        threads.some(
          (thread) => thread.id !== except && inFolder(thread, root) && threadBusy(thread),
        ),
      ),
    );

  const appendLine = (threadId: ThreadId, payload: ParallelChatsLinePayload) => {
    const createdAt = new Date(now()).toISOString();
    return deps
      .dispatch({
        type: "thread.activity.append",
        commandId: commandId("line"),
        threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: PARALLEL_CHATS_ACTIVITY_KIND,
          summary: parallelChatsLine(payload),
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  };

  const setFolder = (threadId: ThreadId, worktreePath: string | null) =>
    deps.dispatch(
      {
        type: "thread.meta.update",
        commandId: commandId("folder"),
        threadId,
        worktreePath,
        branch: null,
      },
      { component: PARALLEL_CHATS_ORIGIN_COMPONENT, reason: worktreePath ? "copy" : "folder" },
    );

  // ── Making a copy ─────────────────────────────────────────────────────

  /** A new copy of the folder's state at `copy`, with its base ref, `.env*` and node_modules. */
  const makeCopy = Effect.fn("ParallelChats.makeCopy")(function* (input: {
    readonly root: string;
    readonly copy: string;
    readonly threadId: string;
  }) {
    const at = rootAt(input.root);
    const tree = yield* git.snapshotTree(at, tempDir);
    const head = yield* git.revParse(at, "HEAD");
    const base = yield* git.commitTree(at, tree, head ? [head] : [], "Uno: parallel chat base");
    yield* git.updateRef(at, baseRefFor(input.threadId), base);
    yield* git.addCopy(input.root, input.copy, base);
    const envFiles = yield* git.listIgnoredEnvFiles(at);
    yield* copyEnvFiles(input.root, input.copy, envFiles);
    yield* linkNodeModules(input.root, input.copy);
  });

  const dropCopy = (root: string, copy: string, threadId: string) =>
    git
      .removeCopy(root, copy)
      .pipe(
        Effect.andThen(git.deleteRef(rootAt(root), baseRefFor(threadId))),
        Effect.ignoreCause({ log: true }),
      );

  /**
   * Move the chat into a copy: the copy, then (for a Claude chat with a
   * session) its transcript, then the thread's folder. Any failure: why the
   * chat can't have a copy (it then waits for the folder, never works on top
   * of the other chat).
   */
  const moveIntoCopy = Effect.fn("ParallelChats.moveIntoCopy")(function* (input: {
    readonly thread: ParallelThread;
    readonly root: string;
    readonly project: OrchestrationProjectShell;
  }): Effect.fn.Return<
    { readonly copy: string } | { readonly refused: string },
    ParallelChatsError
  > {
    const { thread, root } = input;
    const threads = yield* projectThreads(thread.projectId);
    const liveCopies = threads.filter(
      (other) =>
        other.id !== thread.id &&
        isAutoCopyPath(deps.worktreesDir, other.worktreePath) &&
        existsSync(other.worktreePath!),
    ).length;
    const refusal = copyLimitRefusal({
      lowDisk: yield* deps.lowDisk,
      liveCopies,
      fileCount: yield* indexEntryCount(nodePath.join(root, UNO_GIT_DIR, "index")),
    });
    if (refusal !== null) {
      return { refused: refusal };
    }
    const session = yield* deps.sessionOf(thread.id);
    const move = sessionMove({
      hasResumableSession: session?.resumeId != null,
      driver: session?.driver ?? null,
    });
    if (move === "cannot") return { refused: "cannot-move-session" };
    const copy = autoCopyPath({ worktreesDir: deps.worktreesDir, root, threadId: thread.id });
    const made = yield* makeCopy({ root, copy, threadId: thread.id }).pipe(
      Effect.timeoutOption(Duration.millis(COPY_TIMEOUT_MS)),
      Effect.map((result) => result._tag === "Some"),
      Effect.catchCause((cause) =>
        Effect.logWarning("parallel chats: couldn't make a copy", {
          threadId: thread.id,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!made) {
      yield* dropCopy(root, copy, thread.id);
      return { refused: "copy-failed" };
    }
    if (move === "claude-transcript") {
      const moved = yield* copyClaudeTranscript({
        configDirs: yield* deps.claudeConfigDirs,
        sessionId: session!.resumeId!,
        from: thread.worktreePath ?? root,
        to: copy,
      });
      if (!moved) {
        yield* dropCopy(root, copy, thread.id);
        return { refused: "claude-transcript-not-found" };
      }
    }
    yield* setFolder(thread.id, copy);
    yield* Effect.logInfo("parallel chats: the chat works in its own copy", {
      threadId: thread.id,
      projectId: thread.projectId,
      copy,
    });
    return { copy };
  });

  /** The copy can't come back: the chat works in the folder again, a Claude session with it. */
  const backToFolder = Effect.fn("ParallelChats.backToFolder")(function* (
    thread: ParallelThread,
    root: string,
    copy: string,
  ) {
    const session = yield* deps.sessionOf(thread.id);
    if (session?.driver === "claudeAgent" && session.resumeId !== null) {
      yield* copyClaudeTranscript({
        configDirs: yield* deps.claudeConfigDirs,
        sessionId: session.resumeId,
        from: copy,
        to: root,
      });
    }
    yield* setFolder(thread.id, null);
    yield* Effect.logInfo(
      "parallel chats: the copy couldn't come back, the chat works in the folder",
      {
        threadId: thread.id,
      },
    );
  });

  /**
   * A chat back in its copy: a copy removed meanwhile comes back (off: the
   * chat goes back to the folder instead); a copy with everything joined
   * catches up with the folder; a copy with unjoined work stays as it is.
   */
  const refreshOwnCopy = Effect.fn("ParallelChats.refreshOwnCopy")(function* (input: {
    readonly thread: ParallelThread;
    readonly root: string;
    readonly copy: string;
  }) {
    const { thread, root, copy } = input;
    const at = rootAt(root);
    if (!existsSync(copy)) {
      // Removed after it joined (idle for a day) or by hand: it comes back at
      // the same path, off or not — a chat stays in its copy (spec, section 10),
      // and its agent's session lives at that path.
      yield* makeCopy({ root, copy, threadId: thread.id }).pipe(
        Effect.timeoutOption(Duration.millis(COPY_TIMEOUT_MS)),
        Effect.ignoreCause({ log: true }),
      );
      if (!existsSync(copy)) {
        yield* backToFolder(thread, root, copy);
        return null;
      }
      return copy;
    }
    if ((yield* git.revParse(at, conflictRefFor(thread.id))) !== null) return copy;
    const base = yield* git.revParse(at, baseRefFor(thread.id));
    if (base === null) return copy;
    const baseTree = yield* git.treeOf(at, base);
    const copyTree = yield* git.snapshotTree(copyAt(copy), tempDir);
    if (copyTree !== baseTree) return copy;
    const rootTree = yield* git.snapshotTree(at, tempDir);
    if (rootTree === baseTree) return copy;
    const next = yield* git.commitTree(at, rootTree, [base], "Uno: caught up with the project");
    if (yield* git.moveCopy(copy, rootTree)) {
      yield* git.updateRef(at, baseRefFor(thread.id), next);
    }
    return copy;
  });

  const agentNoteFor = Effect.fn("ParallelChats.agentNoteFor")(function* (input: {
    readonly threadId: string;
    readonly root: string;
    readonly copy: string;
  }) {
    const notes = [parallelCopyAgentNote({ copy: input.copy, root: input.root })];
    const conflict = yield* readConflict(input.root, input.threadId);
    if (conflict !== null && conflict.record.kind === "other") {
      notes.push(parkedOtherAgentNote({ files: conflict.record.files, root: input.root }));
    }
    return notes.join("\n\n");
  });

  const beforeTurnUnsafe = Effect.fn("ParallelChats.beforeTurn")(function* (
    input: ParallelThread,
  ): Effect.fn.Return<ParallelTurnStart<ParallelThread>, ParallelChatsError> {
    let thread: ParallelThread = input;
    starting.set(thread.id, now());
    // A chat opened from a chat in a copy inherits its folder: never another chat's copy.
    if (
      isAutoCopyPath(deps.worktreesDir, thread.worktreePath) &&
      !isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)
    ) {
      yield* setFolder(thread.id, null);
      thread = { ...thread, worktreePath: null };
    }
    const mode = yield* deps.mode;
    if (isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)) {
      const project = yield* deps.getProject(thread.projectId);
      if (project === null) return { thread, agentNote: null };
      const root = project.workspaceRoot;
      const copy = yield* refreshOwnCopy({ thread, root, copy: thread.worktreePath! });
      if (copy === null) return { thread: { ...thread, worktreePath: null }, agentNote: null };
      remember(thread, root);
      return { thread, agentNote: yield* agentNoteFor({ threadId: thread.id, root, copy }) };
    }
    if (mode === "off" || thread.worktreePath !== null) return { thread, agentNote: null };
    const project = yield* deps.getProject(thread.projectId);
    if (project === null) return { thread, agentNote: null };
    const root = project.workspaceRoot;
    const ineligible = projectIneligibleReason({
      mode,
      root,
      home,
      isAssistantProject: isAssistantProjectId(project.id),
      repoKind: yield* detectRepoKind(root),
    });
    if (ineligible !== null) return { thread, agentNote: null };
    if (!(yield* folderBusy(thread.projectId, root, thread.id))) {
      toldQueued.delete(thread.id);
      return { thread, agentNote: null };
    }
    const moved = yield* moveIntoCopy({ thread, root, project });
    if ("refused" in moved) {
      // Working in the folder now would overwrite the other chat (or be
      // overwritten): the turn waits for it instead, the person is told once.
      starting.delete(thread.id);
      yield* Effect.logInfo("parallel chats: the chat waits for the folder", {
        threadId: thread.id,
        reason: moved.refused,
      });
      if (!toldQueued.has(thread.id)) {
        toldQueued.add(thread.id);
        yield* appendLine(thread.id, {
          line: "queued",
          ...(moved.refused === "low-disk" ? { lowDisk: true } : {}),
        });
      }
      return { thread, agentNote: null, waitForFolder: true };
    }
    toldQueued.delete(thread.id);
    const copy = moved.copy;
    known.set(thread.id, { root, copy });
    return {
      thread: { ...thread, worktreePath: copy, branch: null },
      agentNote: yield* agentNoteFor({ threadId: thread.id, root, copy }),
    };
  });

  const awaitFolderFree: ParallelChatsShape["awaitFolderFree"] = (threadId) =>
    Effect.gen(function* () {
      while (true) {
        if ((yield* deps.mode) === "off") return;
        const thread = yield* deps.getThread(threadId);
        if (thread === null) return;
        const project = yield* deps.getProject(thread.projectId);
        if (project === null) return;
        if (!(yield* folderBusy(thread.projectId, project.workspaceRoot, thread.id))) return;
        yield* Effect.sleep(HELD_TURN_POLL);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("parallel chats: folder wait failed, the turn goes on", {
          threadId,
          cause,
        }),
      ),
    );

  const beforeTurn: ParallelChatsShape["beforeTurn"] = <T extends ParallelThread>(thread: T) =>
    lock
      .withPermits(1)(beforeTurnUnsafe(thread))
      .pipe(
        Effect.map(
          (result): ParallelTurnStart<T> => ({
            thread: {
              ...thread,
              worktreePath: result.thread.worktreePath,
              branch: result.thread.branch,
            },
            agentNote: result.agentNote,
            ...(result.waitForFolder ? { waitForFolder: true as const } : {}),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("parallel chats: turn start check failed, the chat goes on as is", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as({ thread, agentNote: null } satisfies ParallelTurnStart<T>)),
        ),
      );

  // ── Joining the folder ────────────────────────────────────────────────

  const readConflict = (root: string, threadId: string) =>
    Effect.gen(function* () {
      const at = rootAt(root);
      const ref = yield* git.revParse(at, conflictRefFor(threadId));
      if (ref === null) return null;
      const record = decodeConflictRecord(yield* git.commitMessage(at, ref));
      const parent = yield* git.firstParent(at, ref);
      if (record === null || parent === null) return null;
      return { ref, record, rootCommit: parent };
    });

  /** The other chat named in the combine turn: the folder's busiest recent chat. */
  const otherChatTitle = (projectId: ProjectId, root: string, except: string) =>
    projectThreads(projectId).pipe(
      Effect.map((threads) => {
        const inRoot = threads
          .filter((thread) => thread.id !== except && inFolder(thread, root))
          .toSorted((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
        return inRoot[0]?.title ?? "another chat";
      }),
    );

  /**
   * Text conflicts: the copy holds the merge with markers and the chat gets
   * one turn to combine them. Binary files: both versions stay (the chat's
   * next to the folder's). Others (delete against change, renames): the
   * chat's version stays in the copy and the person decides.
   */
  const startCombining = Effect.fn("ParallelChats.startCombining")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly root: string;
    readonly copy: string;
    readonly mergedTree: string;
    readonly rootCommit: string;
    readonly copyCommit: string;
    readonly conflicts: ReadonlyArray<MergeConflict>;
  }) {
    const { thread, root, copy } = input;
    const at = rootAt(root);
    const text = input.conflicts.filter((conflict) => conflict.kind === "text").map((c) => c.path);
    const binary = input.conflicts
      .filter((conflict) => conflict.kind === "binary")
      .map((c) => c.path);
    const other = input.conflicts
      .filter((conflict) => conflict.kind === "other")
      .map((c) => c.path);
    const otherTitle = yield* otherChatTitle(thread.projectId, root, thread.id);
    if (!(yield* git.moveCopy(copy, input.mergedTree))) return false;
    for (const path of binary) {
      // The merge kept the folder's version: the chat's goes next to it.
      const kept = keptVersionName(path, thread.title);
      yield* git.checkoutPath(copy, input.copyCommit, path);
      yield* Effect.promise(async () => {
        const { rename } = await import("node:fs/promises");
        await rename(nodePath.join(copy, path), nodePath.join(copy, kept));
      });
      yield* git.checkoutPath(copy, input.rootCommit, path);
    }
    for (const path of other) {
      // The chat's version stays in its copy until the person decides.
      const inCopy = yield* git.revParse(copyAt(copy), `${input.copyCommit}:${path}`);
      if (inCopy !== null) {
        yield* git.checkoutPath(copy, input.copyCommit, path).pipe(Effect.ignore);
      } else {
        yield* Effect.promise(async () => {
          const { rm } = await import("node:fs/promises");
          await rm(nodePath.join(copy, path), { recursive: true, force: true });
        });
      }
    }
    if (binary.length > 0) {
      yield* appendLine(thread.id, { line: "kept-both", files: binary });
    }
    if (text.length === 0 && other.length === 0) {
      // Only binaries: nothing to wait for, the copy now agrees with the folder's state.
      yield* git.updateRef(at, baseRefFor(thread.id), input.rootCommit);
      return true;
    }
    const files = [...text, ...other];
    const kind = other.length > 0 ? ("other" as const) : ("text" as const);
    const parkedAt = new Date(now()).toISOString();
    const recordTree = yield* git.snapshotTree(copyAt(copy), tempDir);
    const record = yield* git.commitTree(
      at,
      recordTree,
      [input.rootCommit],
      encodeConflictRecord({ kind, files, otherTitle, parkedAt }),
    );
    yield* git.updateRef(at, conflictRefFor(thread.id), record);
    toldParked.delete(thread.id);
    if (kind === "other") {
      yield* appendLine(thread.id, { line: "kept-both", files: other });
      toldParked.add(thread.id);
      return false;
    }
    const createdAt = new Date(now()).toISOString();
    // Busy from now on: the combine turn is on its way through the reactor queue.
    starting.set(thread.id, now());
    yield* deps.dispatch(
      {
        type: "thread.turn.start",
        commandId: commandId("combine"),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: `${UNO_WORK_NOTE_PREFIX}${parallelResolveNoteBody({
            files: text,
            otherTitle,
            ownTitle: thread.title,
          })}`,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      },
      { component: PARALLEL_CHATS_ORIGIN_COMPONENT, reason: "combine" },
    );
    return false;
  });

  /**
   * One chat's copy into the folder. The chat and the folder are idle.
   * "done": nothing left to join; "wait": try again later.
   */
  const joinOne = Effect.fn("ParallelChats.joinOne")(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly root: string;
    readonly copy: string;
  }): Effect.fn.Return<"done" | "wait" | "parked", ParallelChatsError> {
    const { thread, root, copy } = input;
    const at = rootAt(root);
    const conflict = yield* readConflict(root, thread.id);
    if (conflict !== null) {
      const answeredAfter =
        thread.latestTurn !== null && thread.latestTurn.requestedAt > conflict.record.parkedAt;
      let markers = false;
      if (conflict.record.kind === "text") {
        for (const file of conflict.record.files) {
          if (yield* fileHasMarkers(nodePath.join(copy, file))) markers = true;
        }
      }
      if (markers || !answeredAfter) {
        if (!toldParked.has(thread.id) && answeredAfter) {
          toldParked.add(thread.id);
          yield* appendLine(thread.id, { line: "parked" });
        }
        return "parked";
      }
      yield* git.updateRef(at, baseRefFor(thread.id), conflict.rootCommit);
      yield* git.deleteRef(at, conflictRefFor(thread.id));
      toldParked.delete(thread.id);
    }
    for (let attempt = 1; attempt <= APPLY_ATTEMPTS + 1; attempt++) {
      const base = yield* git.revParse(at, baseRefFor(thread.id));
      if (base === null) return "done";
      const baseTree = yield* git.treeOf(at, base);
      const copyTree = yield* git.snapshotTree(copyAt(copy), tempDir);
      // Nothing changed in the copy (a question, Ask, Plan).
      if (copyTree === baseTree) return "done";
      const shot = yield* git.snapshot(at, tempDir);
      const outcome = yield* Effect.gen(function* () {
        let merged: string;
        const withOthers = shot.tree !== baseTree;
        if (!withOthers) {
          merged = copyTree;
        } else {
          const rootCommit = yield* git.commitTree(at, shot.tree, [base], "Uno: the project");
          const copyCommit = yield* git.commitTree(at, copyTree, [base], "Uno: this chat");
          const result = yield* git.mergeCommits(at, rootCommit, copyCommit);
          if (!result.clean) {
            const settled = yield* startCombining({
              thread,
              root,
              copy,
              mergedTree: result.tree,
              rootCommit,
              copyCommit,
              conflicts: result.conflicts,
            });
            return settled ? ("again" as const) : ("parked" as const);
          }
          merged = result.tree;
        }
        if (!(yield* git.applyToRoot(root, shot.tree, merged, shot.indexFile))) {
          return "refused" as const;
        }
        yield* git.moveCopy(copy, merged);
        const next = yield* git.commitTree(at, merged, [base], "Uno: joined the project");
        yield* git.updateRef(at, baseRefFor(thread.id), next);
        if (withOthers) yield* appendLine(thread.id, { line: "joined" });
        yield* Effect.logInfo("parallel chats: a chat's work joined the project", {
          threadId: thread.id,
          withOthers,
        });
        return "joined" as const;
      }).pipe(Effect.ensuring(shot.release));
      if (outcome === "joined") return "done";
      if (outcome === "parked") return "parked";
      if (outcome === "refused") {
        if (attempt >= APPLY_ATTEMPTS) return "wait";
        yield* Effect.sleep(Duration.millis(APPLY_RETRY_DELAY_MS));
      }
      // "again": the copy changed under our hands (binary versions kept): once more.
    }
    return "wait";
  });

  const drainProject = Effect.fn("ParallelChats.drainProject")(function* (projectId: ProjectId) {
    const project = yield* deps.getProject(projectId);
    if (project === null) return;
    const root = project.workspaceRoot;
    const threads = yield* projectThreads(projectId);
    const waiting = threads
      .filter(
        (thread) =>
          pending.has(thread.id) &&
          isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id),
      )
      .toSorted((a, b) => (pending.get(a.id) ?? 0) - (pending.get(b.id) ?? 0));
    for (const thread of threads) {
      if (
        pending.has(thread.id) &&
        !isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)
      ) {
        pending.delete(thread.id);
      }
    }
    for (const thread of waiting) {
      remember(thread, root);
      if (threadBusy(thread)) continue;
      const copy = thread.worktreePath!;
      if (!existsSync(copy)) {
        pending.delete(thread.id);
        continue;
      }
      if (yield* folderBusy(projectId, root, null)) {
        if (!toldWaiting.has(thread.id)) {
          const at = rootAt(root);
          const base = yield* git.revParse(at, baseRefFor(thread.id));
          const unjoined =
            base !== null &&
            (yield* git.snapshotTree(copyAt(copy), tempDir)) !== (yield* git.treeOf(at, base));
          if (unjoined) {
            toldWaiting.add(thread.id);
            yield* appendLine(thread.id, { line: "waiting" });
          }
        }
        continue;
      }
      const result = yield* joinOne({ thread, root, copy }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("parallel chats: couldn't join a chat's work yet", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as("wait" as const)),
        ),
      );
      if (result !== "wait") {
        pending.delete(thread.id);
        toldWaiting.delete(thread.id);
      }
    }
  });

  const drainProjectLocked = (projectId: ProjectId) =>
    lock
      .withPermits(1)(drainProject(projectId))
      .pipe(Effect.ignoreCause({ log: true }));

  const drainAll: ParallelChatsShape["drainAll"] = Effect.gen(function* () {
    if (pending.size === 0) return;
    const threads = yield* deps.listThreads;
    const projects = new Set(
      threads.filter((thread) => pending.has(thread.id)).map((thread) => thread.projectId),
    );
    for (const id of pending.keys()) {
      if (!threads.some((thread) => thread.id === id)) pending.delete(id);
    }
    for (const projectId of projects) yield* drainProjectLocked(projectId);
  }).pipe(Effect.ignoreCause({ log: true }));

  /** After a restart: every chat in its own copy may have work to join. */
  const reconcile = Effect.gen(function* () {
    const threads = yield* deps.listThreads;
    for (const thread of threads) {
      if (isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)) {
        if (!pending.has(thread.id)) pending.set(thread.id, now());
        const project = yield* deps.getProject(thread.projectId);
        if (project !== null) remember(thread, project.workspaceRoot);
      }
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * Copies whose work all joined, of chats quiet for a day, with no process
   * in them: removed (the base ref stays; the next message makes the copy
   * again at the same path). Unjoined work is never removed.
   */
  const sweepIdleCopies = Effect.gen(function* () {
    const threads = yield* deps.listThreads;
    for (const thread of threads) {
      if (!isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)) continue;
      const copy = thread.worktreePath!;
      if (!existsSync(copy) || threadBusy(thread) || pending.has(thread.id)) continue;
      const lastActivity = Math.max(
        Date.parse(thread.updatedAt),
        thread.latestTurn ? Date.parse(thread.latestTurn.requestedAt) : 0,
      );
      if (!(now() - lastActivity > IDLE_COPY_AFTER_MS)) continue;
      if (yield* processRunsIn(copy)) continue;
      const project = yield* deps.getProject(thread.projectId);
      if (project === null) continue;
      const root = project.workspaceRoot;
      yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const at = rootAt(root);
            if ((yield* git.revParse(at, conflictRefFor(thread.id))) !== null) return;
            const base = yield* git.revParse(at, baseRefFor(thread.id));
            if (base === null) return;
            const copyTree = yield* git.snapshotTree(copyAt(copy), tempDir);
            if (copyTree !== (yield* git.treeOf(at, base))) return;
            yield* git.removeCopy(root, copy);
            yield* Effect.logInfo("parallel chats: removed an idle copy, all its work joined", {
              threadId: thread.id,
            });
          }),
        )
        .pipe(Effect.ignoreCause({ log: true }));
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  /**
   * A deleted chat's copy: what never joined the project is saved first
   * (`refs/uno/saved/<chat>`, like the chat-copy cleanup), then the copy goes.
   */
  const forgetDeleted = (threadId: ThreadId) =>
    Effect.gen(function* () {
      pending.delete(threadId);
      starting.delete(threadId);
      toldWaiting.delete(threadId);
      toldParked.delete(threadId);
      const place = known.get(threadId);
      known.delete(threadId);
      if (place === undefined || !existsSync(place.copy)) return;
      const at = rootAt(place.root);
      const base = yield* git.revParse(at, baseRefFor(threadId));
      const copyTree = yield* git.snapshotTree(copyAt(place.copy), tempDir);
      if (base === null || copyTree !== (yield* git.treeOf(at, base))) {
        const saved = yield* git.commitTree(
          at,
          copyTree,
          base === null ? [] : [base],
          "Uno: a deleted chat's work that never joined the project",
        );
        yield* git.updateRef(at, `refs/uno/saved/${threadId}`, saved);
      }
      yield* git.removeCopy(place.root, place.copy);
      yield* git.deleteRef(at, baseRefFor(threadId));
      yield* git.deleteRef(at, conflictRefFor(threadId));
      yield* Effect.logInfo("parallel chats: removed a deleted chat's copy", { threadId });
    }).pipe((effect) => lock.withPermits(1)(effect), Effect.ignoreCause({ log: true }));

  const onEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.session-set": {
          const { threadId, session } = event.payload;
          if (startingTurnClearedBy(session.status)) starting.delete(threadId);
          if (!sessionEndsTurn(session.status) && session.status !== "error") return;
          const thread = yield* deps.getThread(threadId);
          if (thread === null) return;
          if (
            sessionEndsTurn(session.status) &&
            isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)
          ) {
            if (!pending.has(threadId)) pending.set(threadId, now());
          }
          // Any chat of the project finished: the folder may be free for waiting copies.
          if (pending.size > 0) yield* drainProjectLocked(thread.projectId);
          return;
        }
        case "thread.reverted": {
          const thread = yield* deps.getThread(event.payload.threadId);
          if (thread === null) return;
          if (!isOwnAutoCopy(deps.worktreesDir, thread.worktreePath, thread.id)) return;
          if (!pending.has(thread.id)) pending.set(thread.id, now());
          yield* drainProjectLocked(thread.projectId);
          return;
        }
        case "thread.deleted":
          yield* forgetDeleted(event.payload.threadId);
          return;
        default:
          return;
      }
    }).pipe(Effect.ignoreCause({ log: true }));

  const start: ParallelChatsShape["start"] = () =>
    Effect.gen(function* () {
      yield* reconcile;
      if (deps.domainEvents !== undefined) {
        yield* Stream.runForEach(deps.domainEvents, (event) =>
          event.type === "thread.session-set" ||
          event.type === "thread.reverted" ||
          event.type === "thread.deleted"
            ? onEvent(event).pipe(Effect.forkDetach, Effect.asVoid)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("parallel chats: event stream failed", { cause }),
          ),
          Effect.forkScoped,
        );
      }
      yield* drainAll.pipe(
        Effect.delay(PARALLEL_TICK),
        Effect.repeat(Schedule.spaced(PARALLEL_TICK)),
        Effect.forkScoped,
      );
      yield* sweepIdleCopies.pipe(
        Effect.delay(IDLE_SWEEP_INTERVAL),
        Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
        Effect.forkScoped,
      );
    });

  return {
    beforeTurn,
    awaitFolderFree,
    start,
    drainAll,
    /** Tests: the in-memory queue. */
    pendingIds: () => [...pending.keys()],
    onEvent,
    reconcile,
    sweepIdleCopies,
  };
});

// ── Live layer ──────────────────────────────────────────────────────────

/** The id a saved session resumes with: Claude's session id, else a marker that one exists. */
export function resumeIdOf(driver: string | null, cursor: unknown): string | null {
  if (cursor === null || cursor === undefined) return null;
  if (driver === "claudeAgent" && typeof cursor === "object") {
    const value = cursor as { readonly resume?: unknown; readonly sessionId?: unknown };
    const id =
      typeof value.resume === "string"
        ? value.resume
        : typeof value.sessionId === "string"
          ? value.sessionId
          : null;
    return id;
  }
  return "saved-session";
}

export interface ParallelChatsLayerOptions {
  /** Tests only: whether the disk counts as nearly full. */
  readonly lowDisk?: Effect.Effect<boolean>;
}

export const makeParallelChatsLayer = (options: ParallelChatsLayerOptions = {}) =>
  Layer.effect(
    ParallelChats,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const settingsService = yield* ServerSettingsService;
      const projections = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const vcs = yield* GitVcsDriver;
      const directory = Option.getOrUndefined(
        yield* Effect.serviceOption(ProviderSessionDirectory),
      );

      const settings = settingsService.getSettings.pipe(Effect.option);

      const service = yield* makeParallelChats({
        worktreesDir: config.worktreesDir,
        tempDir: config.tempDir,
        git: vcs.execute,
        mode: settings.pipe(
          Effect.map((value) =>
            effectiveParallelMode(Option.isSome(value) ? value.value.parallelChats : undefined),
          ),
        ),
        getProject: (projectId) =>
          projections.getProjectShellById(projectId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          ),
        getThread: (threadId) =>
          projections.getThreadShellById(threadId).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          ),
        listThreads: projections.getShellSnapshot().pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.orElseSucceed(() => []),
        ),
        dispatch: (command, origin) =>
          engine
            .dispatch(
              command,
              origin
                ? { origin: systemCommandOrigin(origin.component, origin.reason ?? null) }
                : {},
            )
            .pipe(Effect.asVoid, Effect.orDie),
        domainEvents: engine.streamDomainEvents,
        sessionOf: (threadId) =>
          directory === undefined
            ? Effect.succeed(null)
            : directory.getBinding(threadId).pipe(
                Effect.map(Option.getOrNull),
                Effect.map((binding) =>
                  binding === null
                    ? null
                    : {
                        driver: binding.provider,
                        resumeId: resumeIdOf(binding.provider, binding.resumeCursor),
                      },
                ),
                Effect.orElseSucceed(() => null),
              ),
        claudeConfigDirs: settings.pipe(
          Effect.map((value) => {
            const dirs = [
              claudeConfigDir({
                homePath: Option.isSome(value) ? value.value.providers.claudeAgent.homePath : "",
                environment: process.env,
              }),
            ];
            if (Option.isSome(value)) {
              for (const instance of Object.values(value.value.providerInstances)) {
                const dir = instanceClaudeConfigDir(instance.environment);
                if (dir) dirs.push(dir);
              }
            }
            return dirs;
          }),
        ),
        lowDisk:
          options.lowDisk ??
          Effect.promise(() => diskSpaceAt(config.worktreesDir).catch(() => null)).pipe(
            Effect.map(isLowDisk),
          ),
      });
      return {
        beforeTurn: service.beforeTurn,
        awaitFolderFree: service.awaitFolderFree,
        start: service.start,
        drainAll: service.drainAll,
      } satisfies ParallelChatsShape;
    }),
  );

export const ParallelChatsLive = makeParallelChatsLayer();
