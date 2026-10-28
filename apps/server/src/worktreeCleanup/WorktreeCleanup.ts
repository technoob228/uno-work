/**
 * WorktreeCleanup — Uno Work cleans the chat copies (git worktrees under
 * `<baseDir>/worktrees`) by itself, so a 10 GB cloud disk doesn't fill up
 * with a node_modules per chat (09.10: a 40 GB box filled up with 20+ copies
 * of ~400 MB each). Settings → Computer → Advanced (`storageCleanup`).
 *
 * - When: ~10 minutes after start, then hourly; shortly after a chat is
 *   deleted / Done / archived; and when a cheap disk check (every 10 minutes)
 *   sees the disk nearly full. Passes never overlap (one worker).
 * - What: see policy.ts. Each copy is checked like upstream T3 Code's storage
 *   cleanup — only `<worktrees>/<repo>/<branch>` folders with a `.git` file
 *   of the chat's own repository, on the chat's branch, nothing running, no
 *   terminal, no live agent session, not shared — and checked again right
 *   before it goes.
 * - Never loses work: uncommitted changes become a snapshot commit at
 *   `refs/uno/saved/<chat>` and ignored `.env*` files are copied to
 *   `<baseDir>/saved-worktrees/<chat>/`; if saving fails, the copy stays.
 *   Branches are never deleted.
 * - The chat keeps working: its next message (or opening its terminal)
 *   checks the branch out again, lays the snapshot back as uncommitted
 *   changes and the `.env*` files, then drops the saved copies.
 *
 * No Inbox / Telegram news: a log line and the last report for the settings.
 *
 * @module worktreeCleanup/WorktreeCleanup
 */
import type {
  OrchestrationEvent,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  StorageCleanupSettings,
  StorageCleanupStatus,
} from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { lstat, readdir } from "node:fs/promises";
import nodePath from "node:path";
import { Context, Deferred, Duration, Effect, Layer, Option, Ref, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { diskSpaceAt } from "../files/diskSpace.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  type CleanupRules,
  type CleanupThread,
  type DiskSpaceReading,
  ACTIVITY_GRACE_MS,
  cleanupEnabled,
  deletedThreadVerdict,
  effectiveRules,
  isLowDisk,
  liveThreadVerdict,
  sentence,
  threadActivityMs,
  threadBusyReason,
} from "./policy.ts";
import {
  type GitExec,
  type WorktreeState,
  ENV_FILES_MAX,
  SAVED_CHANGES_MAX_BYTES,
  WorktreeCleanupError,
  changedFilesBytes,
  deleteRef,
  isInside,
  listIgnoredEnvFiles,
  measureFolderBytes,
  pathExists,
  readLocalChanges,
  readWorktreeState,
  realPathOrNull,
  recreateWorktree,
  refExists,
  removeSavedFiles,
  removeWorktree,
  repositoryCommonDir,
  restoreEnvFiles,
  restoreSnapshot,
  saveEnvFiles,
  saveSnapshot,
  savedRefFor,
  snapshotBase,
  writeWorkingTree,
} from "./worktreeGit.ts";

export { WorktreeCleanupError } from "./worktreeGit.ts";

export const FIRST_PASS_DELAY = Duration.minutes(10);
export const PASS_INTERVAL = Duration.hours(1);
export const DISK_CHECK_INTERVAL = Duration.minutes(10);
/** After a delete: give the deletion reactor time to stop the session and terminals. */
export const AFTER_DELETE_DELAY = Duration.seconds(30);
/** After Done / archive: past the activity grace, so a low-disk pass can act. */
export const AFTER_SETTLE_DELAY = Duration.millis(ACTIVITY_GRACE_MS + 60_000);
/** Low disk that persists: another pass at most this often (besides the hourly one). */
const LOW_DISK_REPASS_MS = 30 * 60_000;
const REPORT_ENTRY_LIMIT = 200;
const COPIES_MEASURE_TTL_MS = 5 * 60_000;

const listDirectories = (parent: string) =>
  Effect.promise(async () => {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => nodePath.join(parent, entry.name));
  });

export interface CleanupProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

export interface DeletedCleanupThread {
  readonly id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string;
}

export interface CleanupThreadsSnapshot {
  readonly projects: ReadonlyArray<CleanupProject>;
  readonly threads: ReadonlyArray<CleanupThread>;
  readonly deleted: ReadonlyArray<DeletedCleanupThread>;
}

export interface CleanupTerminal {
  readonly threadId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly status: string;
}

export interface CleanupSession {
  readonly threadId: string;
  readonly cwd?: string | undefined;
}

/** What the cleanup reads and acts through; tests pass fakes for everything but git. */
export interface WorktreeCleanupDeps {
  readonly worktreesDir: string;
  /** `<baseDir>/saved-worktrees`: saved `.env*` files, one folder per chat. */
  readonly savedDir: string;
  readonly tempDir: string;
  readonly git: GitExec;
  readonly settings: Effect.Effect<StorageCleanupSettings>;
  readonly readThreads: Effect.Effect<CleanupThreadsSnapshot, WorktreeCleanupError>;
  /** A live (not deleted) chat; null when deleted or unknown. */
  readonly getThread: (threadId: string) => Effect.Effect<CleanupThread | null>;
  readonly getProject: (projectId: string) => Effect.Effect<CleanupProject | null>;
  readonly liveSessions: Effect.Effect<ReadonlyArray<CleanupSession>>;
  readonly terminals: Effect.Effect<ReadonlyArray<CleanupTerminal>>;
  readonly diskSpace: (path: string) => Effect.Effect<DiskSpaceReading | null>;
  readonly now?: () => number;
  readonly domainEvents?: Stream.Stream<Pick<OrchestrationEvent, "type">>;
}

export interface WorktreeCleanupShape {
  /** Run a pass now (after any running one) and return its report. */
  readonly runNow: Effect.Effect<StorageCleanupReport>;
  readonly status: Effect.Effect<StorageCleanupStatus>;
  /**
   * Bring the chat's copy back if the cleanup (or anyone) removed it: check
   * its branch out again, restore saved changes and `.env*` files. A no-op
   * when the folder is there or the chat has no copy.
   */
  readonly ensureThreadWorktree: (threadId: string) => Effect.Effect<void, WorktreeCleanupError>;
  /** Terminal open/restart: bring the copy back first when the terminal is for it. */
  readonly prepareTerminal: (input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly worktreePath?: string | null | undefined;
  }) => Effect.Effect<void>;
  /** Start the schedule, the disk check and the event triggers (in the given scope). */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** How much the chat copies take now (measured at most every few minutes). */
  readonly copiesOnDisk: Effect.Effect<ChatCopiesOnDisk>;
  /** Waits for queued passes (tests). */
  readonly drain: Effect.Effect<void>;
}

export interface ChatCopiesOnDisk {
  readonly worktreesDir: string;
  /** Folders `<repo>/<branch>` under it. */
  readonly copies: number;
  /** Null when it couldn't be measured in time. */
  readonly bytes: number | null;
}

export class WorktreeCleanup extends Context.Service<WorktreeCleanup, WorktreeCleanupShape>()(
  "t3/worktreeCleanup/WorktreeCleanup",
) {}

class Keep {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const sameResolved = (left: string, right: string) =>
  nodePath.resolve(left) === nodePath.resolve(right);

export const makeWorktreeCleanup = Effect.fn("makeWorktreeCleanup")(function* (
  deps: WorktreeCleanupDeps,
) {
  const now = deps.now ?? Date.now;
  const leases = new Map<string, Semaphore.Semaphore>();
  /** One removal or one recreation per folder at a time. */
  const withLease = <A, E, R>(target: string, effect: Effect.Effect<A, E, R>) => {
    const key = nodePath.resolve(target);
    let lease = leases.get(key);
    if (lease === undefined) {
      lease = Semaphore.makeUnsafe(1);
      leases.set(key, lease);
    }
    return lease.withPermits(1)(effect);
  };

  const reportRef = yield* Ref.make<StorageCleanupReport | null>(null);
  const runningRef = yield* Ref.make(false);

  const savedFilesDir = (threadId: string) =>
    savedRefFor(threadId) === null ? null : nodePath.join(deps.savedDir, threadId);

  const terminalOpenIn = (worktreePath: string, terminals: ReadonlyArray<CleanupTerminal>) =>
    terminals.some((terminal) => {
      if (terminal.status !== "starting" && terminal.status !== "running") return false;
      const cwd = nodePath.resolve(terminal.cwd);
      return (
        (terminal.worktreePath !== null && sameResolved(terminal.worktreePath, worktreePath)) ||
        cwd === worktreePath ||
        isInside(worktreePath, cwd)
      );
    });

  const sessionOpenIn = (
    worktreePath: string,
    threadIds: ReadonlySet<string>,
    sessions: ReadonlyArray<CleanupSession>,
  ) =>
    sessions.some((session) => {
      if (threadIds.has(session.threadId)) return true;
      if (session.cwd === undefined) return false;
      const cwd = nodePath.resolve(session.cwd);
      return cwd === worktreePath || isInside(worktreePath, cwd);
    });

  /** `<worktrees>/<repo>/<branch>`: the only folders the cleanup removes or brings back. */
  const isManagedCopyPath = Effect.fn("WorktreeCleanup.isManagedCopyPath")(function* (
    worktreePath: string,
  ) {
    const resolvedRoot = nodePath.resolve(deps.worktreesDir);
    const realRoot = (yield* realPathOrNull(resolvedRoot)) ?? resolvedRoot;
    return [resolvedRoot, realRoot].some(
      (root) =>
        isInside(root, worktreePath) &&
        nodePath.relative(root, worktreePath).split(nodePath.sep).length === 2,
    );
  });

  const containsProjectRoot = Effect.fn("WorktreeCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const resolved = nodePath.resolve(project.workspaceRoot);
      const real = (yield* realPathOrNull(resolved)) ?? resolved;
      for (const candidate of [resolved, real]) {
        if (candidate === worktreePath || isInside(worktreePath, candidate)) return true;
      }
    }
    return false;
  });

  /** Everything that must hold for a copy to go; read again right before removal. */
  const inspect = Effect.fn("WorktreeCleanup.inspect")(function* (input: {
    readonly worktreePath: string;
    readonly root: string;
    readonly branch: string | null;
    readonly threadIds: ReadonlySet<string>;
    readonly project: { readonly workspaceRoot: string } | undefined;
    readonly projects: ReadonlyArray<CleanupProject>;
  }) {
    const { worktreePath } = input;
    if (input.branch === null) return new Keep("no branch is recorded for this copy");
    if (input.project === undefined) return new Keep("the chat's project is gone");
    if (terminalOpenIn(worktreePath, yield* deps.terminals)) {
      return new Keep("a terminal is open in it");
    }
    if (sessionOpenIn(worktreePath, input.threadIds, yield* deps.liveSessions)) {
      return new Keep("the agent's session is still open");
    }
    // Symlinked parents are fine; a symlinked copy folder is never followed.
    const real = yield* realPathOrNull(worktreePath);
    const realParent = yield* realPathOrNull(nodePath.dirname(worktreePath));
    if (real === null || realParent === null) return new Keep("the folder can't be read");
    if (real !== nodePath.join(realParent, nodePath.basename(worktreePath))) {
      return new Keep("it is a symbolic link");
    }
    const relative = nodePath.relative(input.root, real);
    if (!isInside(input.root, real) || relative.split(nodePath.sep).length !== 2) {
      return new Keep("it is outside the chat copies folder");
    }
    if (yield* containsProjectRoot(real, [input.project, ...input.projects])) {
      return new Keep("a project's main folder is inside it");
    }
    const dotGit = yield* Effect.promise(() => lstat(nodePath.join(real, ".git")).catch(() => null));
    if (dotGit === null || !dotGit.isFile()) return new Keep("it isn't a linked git worktree");
    const repoCwd = yield* realPathOrNull(input.project.workspaceRoot);
    if (repoCwd === null) return new Keep("the project's folder is missing");
    const state = yield* readWorktreeState(deps.git, real);
    if (state.commonDir !== (yield* repositoryCommonDir(deps.git, repoCwd))) {
      return new Keep("it belongs to another repository");
    }
    if (state.branch !== input.branch) {
      return new Keep(
        state.branch === null
          ? "its branch was switched to a detached commit"
          : `its branch changed to ${state.branch}`,
      );
    }
    if (state.headSha === null) return new Keep("its branch has no commits");
    if (state.locked) return new Keep("it is locked in git");
    if (state.indexLocked) return new Keep("git is busy in it");
    if (state.hasSubmodules) return new Keep("it has git submodules");
    const changes = yield* readLocalChanges(deps.git, real);
    if (changes.truncated) return new Keep("too many changed files to save safely");
    if (changes.nestedRepository !== null) {
      return new Keep(`another git repository is inside (${changes.nestedRepository})`);
    }
    return {
      real,
      repoCwd,
      state: state as WorktreeState & { readonly headSha: string },
      changes: changes.paths,
    };
  });

  const processWorktree = Effect.fn("WorktreeCleanup.processWorktree")(function* (input: {
    readonly worktreePath: string;
    readonly root: string;
    readonly live: ReadonlyArray<CleanupThread>;
    readonly deleted: ReadonlyArray<DeletedCleanupThread>;
    readonly projects: ReadonlyArray<CleanupProject>;
    readonly rules: CleanupRules;
    readonly at: number;
    readonly entries: StorageCleanupReportEntry[];
  }) {
    const { worktreePath, rules, at } = input;
    const isDeleted = input.live.length === 0;
    const owner: CleanupThread | DeletedCleanupThread = isDeleted
      ? input.deleted[0]!
      : input.live[0]!;
    const project = isDeleted
      ? { workspaceRoot: (owner as DeletedCleanupThread).workspaceRoot }
      : input.projects.find((entry) => entry.id === (owner as CleanupThread).projectId);
    const entry: StorageCleanupReportEntry = {
      kind: "worktree",
      outcome: "kept",
      reason: "",
      path: worktreePath,
      projectPath: project?.workspaceRoot ?? null,
      threadId: owner.id,
      threadTitle: owner.title,
      bytes: null,
      saved: false,
    };
    const keep = (reason: string) => {
      input.entries.push({ ...entry, reason: sentence(reason) });
    };
    const threadIds = new Set([
      ...input.live.map((thread) => thread.id as string),
      ...input.deleted.map((thread) => thread.id),
    ]);

    const verdictFor = (thread: CleanupThread | null, currentRules: CleanupRules) => {
      if (isDeleted) {
        // A deleted chat that is live again (it can't be today) keeps its copy.
        return thread === null
          ? deletedThreadVerdict(currentRules)
          : { remove: false as const, reason: "the chat is back" };
      }
      if (thread === null) return { remove: false as const, reason: "the chat changed during the check" };
      const busy = threadBusyReason(thread, at);
      return busy !== null
        ? { remove: false as const, reason: busy }
        : liveThreadVerdict(thread, currentRules, at);
    };

    if (input.live.length > 1) return keep(`shared by ${input.live.length} chats`);
    const verdict = verdictFor(isDeleted ? null : input.live[0]!, rules);
    if (!verdict.remove) return keep(verdict.reason);

    yield* withLease(
      worktreePath,
      Effect.gen(function* () {
        if (!(yield* pathExists(worktreePath))) return;
        const inspectInput = {
          worktreePath,
          root: input.root,
          branch: owner.branch,
          threadIds,
          project,
          projects: input.projects,
        };
        const first = yield* inspect(inspectInput);
        if (first instanceof Keep) return keep(first.reason);
        const dirty = first.changes.length > 0;
        if (dirty && !rules.saveChanges) return keep("it has uncommitted changes");
        if (dirty) {
          const size = yield* changedFilesBytes(first.real, first.changes);
          if (size > SAVED_CHANGES_MAX_BYTES) {
            return keep(
              `its uncommitted files are too big to save (${Math.round(size / 1024 ** 2)} MB)`,
            );
          }
        }
        const envFiles = yield* listIgnoredEnvFiles(deps.git, first.real);
        if (envFiles.length > 0 && !rules.saveChanges) return keep("it has .env files");
        if (envFiles.length > ENV_FILES_MAX) return keep("it has too many .env files to save");
        const ref = savedRefFor(owner.id);
        const filesDir = savedFilesDir(owner.id);
        if ((dirty || envFiles.length > 0) && (ref === null || filesDir === null)) {
          return keep("its changes can't be saved for this chat");
        }

        const bytes = yield* measureFolderBytes(first.real);

        // Again, right before removal: new activity, settings or files cancel it.
        const currentThread = yield* deps.getThread(owner.id);
        const currentRules = effectiveRules(yield* deps.settings, rules.lowDisk);
        const current = verdictFor(currentThread, currentRules);
        if (!current.remove) return keep(current.reason);
        if (
          currentThread !== null &&
          (currentThread.worktreePath === null ||
            !sameResolved(currentThread.worktreePath, worktreePath) ||
            currentThread.branch !== owner.branch ||
            threadActivityMs(currentThread) !== threadActivityMs(owner as CleanupThread))
        ) {
          return keep("the chat was used during the check");
        }
        const second = yield* inspect(inspectInput);
        if (second instanceof Keep) return keep(second.reason);
        if (
          second.state.headSha !== first.state.headSha ||
          second.changes.join("\0") !== first.changes.join("\0")
        ) {
          return keep("files changed during the check");
        }

        let tree: string | null = null;
        if (dirty) {
          const working = yield* writeWorkingTree(
            deps.git,
            second.real,
            second.state.headSha,
            deps.tempDir,
          );
          if (working.gitlink !== null) {
            return keep(`another git repository is inside (${working.gitlink})`);
          }
          tree = working.tree;
        }

        // Save, check once more, remove. Until `git worktree remove` runs, any
        // failure drops what was saved: the copy itself is still there.
        let wroteRef = false;
        let wroteFiles = false;
        const rollback = Effect.gen(function* () {
          if (wroteRef && ref !== null) yield* deleteRef(deps.git, second.repoCwd, ref);
          if (wroteFiles && filesDir !== null) yield* removeSavedFiles(filesDir);
        }).pipe(Effect.ignore);
        const saveAndVerify = Effect.gen(function* () {
          if (envFiles.length > 0 && filesDir !== null) {
            wroteFiles = true;
            yield* saveEnvFiles(second.real, envFiles, filesDir);
          }
          if (tree !== null && ref !== null) {
            wroteRef = true;
            yield* saveSnapshot(deps.git, second.real, {
              ref,
              tree,
              headSha: second.state.headSha,
              message: `Uno Work: saved changes of chat ${owner.id} (${owner.branch})`,
            });
            const again = yield* writeWorkingTree(
              deps.git,
              second.real,
              second.state.headSha,
              deps.tempDir,
            );
            if (again.tree !== tree) return new Keep("files changed while saving");
          } else {
            const again = yield* readLocalChanges(deps.git, second.real);
            if (again.paths.length > 0 || again.truncated) {
              return new Keep("files changed while saving");
            }
          }
          const state = yield* readWorktreeState(deps.git, second.real);
          if (state.branch !== owner.branch || state.headSha !== second.state.headSha) {
            return new Keep("the branch moved while saving");
          }
          return null;
        });
        const saved = yield* saveAndVerify.pipe(
          Effect.tapError(() => rollback),
        );
        if (saved instanceof Keep) {
          yield* rollback;
          return keep(saved.reason);
        }
        // Forced only when the snapshot was just checked against the copy.
        yield* removeWorktree(deps.git, second.repoCwd, second.real, tree !== null);
        input.entries.push({
          ...entry,
          outcome: "removed",
          reason: sentence(current.reason),
          bytes,
          saved: wroteRef || wroteFiles,
        });
        yield* Effect.logInfo("worktree cleanup removed a chat copy", {
          threadId: owner.id,
          worktreePath,
          reason: current.reason,
          bytes,
          savedChanges: wroteRef,
          savedEnvFiles: wroteFiles ? envFiles.length : 0,
        });
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          input.entries.push({ ...entry, outcome: "failed", reason: error.message });
          yield* Effect.logWarning("worktree cleanup couldn't remove a chat copy", {
            threadId: owner.id,
            worktreePath,
            error: error.message,
          });
        }),
      ),
    );
  });

  const sweep = Effect.fn("WorktreeCleanup.sweep")(function* (
    rules: CleanupRules,
    at: number,
    entries: StorageCleanupReportEntry[],
  ) {
    const root = yield* realPathOrNull(deps.worktreesDir);
    if (root === null || nodePath.parse(root).root === root) return;
    const snapshot = yield* deps.readThreads;
    const live = new Map<string, CleanupThread[]>();
    for (const thread of snapshot.threads) {
      if (thread.worktreePath === null) continue;
      const key = nodePath.resolve(thread.worktreePath);
      live.set(key, [...(live.get(key) ?? []), thread]);
    }
    const deleted = new Map<string, DeletedCleanupThread[]>();
    for (const thread of snapshot.deleted) {
      if (thread.worktreePath === null) continue;
      const key = nodePath.resolve(thread.worktreePath);
      deleted.set(key, [...(deleted.get(key) ?? []), thread]);
    }
    for (const worktreePath of new Set([...live.keys(), ...deleted.keys()])) {
      if (!(yield* pathExists(worktreePath))) continue;
      yield* processWorktree({
        worktreePath,
        root,
        live: live.get(worktreePath) ?? [],
        deleted: deleted.get(worktreePath) ?? [],
        projects: snapshot.projects,
        rules,
        at,
        entries,
      });
    }
  });

  const pass = Effect.fn("WorktreeCleanup.pass")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    yield* Ref.set(runningRef, true);
    const startedAt = now();
    const space = yield* deps.diskSpace(deps.worktreesDir);
    const rules = effectiveRules(yield* deps.settings, isLowDisk(space));
    const entries: StorageCleanupReportEntry[] = [];
    if (cleanupEnabled(rules)) {
      yield* sweep(rules, startedAt, entries).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: "worktree",
              outcome: "failed",
              reason: error.message,
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: null,
              saved: false,
            });
            yield* Effect.logWarning("worktree cleanup pass failed", { error: error.message });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const item of entries) {
      counts[item.outcome]++;
      if (item.outcome === "removed") bytesFreed += item.bytes ?? 0;
    }
    const rank = (item: StorageCleanupReportEntry) =>
      item.outcome === "failed" ? 0 : item.outcome === "removed" ? 1 : 2;
    const report: StorageCleanupReport = {
      trigger,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      lowDisk: rules.lowDisk,
      entries: [...entries].sort((a, b) => rank(a) - rank(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
      bytesFreed,
    };
    yield* Ref.set(reportRef, report);
    if (counts.removed > 0 || counts.failed > 0 || trigger === "manual") {
      yield* Effect.logInfo("worktree cleanup pass", {
        trigger,
        lowDisk: rules.lowDisk,
        ...counts,
        bytesFreed,
      });
    }
    return report;
  }, Effect.ensuring(Effect.suspend(() => Ref.set(runningRef, false))));

  const automaticQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport> | undefined) =>
      (completion === undefined ? Ref.set(automaticQueued, false) : Effect.void).pipe(
        Effect.andThen(pass(completion === undefined ? "automatic" : "manual")),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? Effect.void
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  /** At most one automatic pass waits in the queue. */
  const requestPass = Ref.getAndSet(automaticQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue(undefined))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

  const ensureThreadWorktree = Effect.fn("WorktreeCleanup.ensureThreadWorktree")(function* (
    threadId: string,
  ) {
    const thread = yield* deps.getThread(threadId);
    if (thread === null || thread.worktreePath === null || thread.branch === null) return;
    const worktreePath = nodePath.resolve(thread.worktreePath);
    const branch = thread.branch;
    // Always through the lease: a removal in flight finishes first, then the
    // copy is brought back.
    yield* withLease(
      worktreePath,
      Effect.gen(function* () {
        if (yield* pathExists(worktreePath)) return;
        // A copy somewhere else was never the cleanup's: left as it is.
        if (!(yield* isManagedCopyPath(worktreePath))) return;
        const project = yield* deps.getProject(thread.projectId);
        const repoCwd = project === null ? null : yield* realPathOrNull(project.workspaceRoot);
        if (repoCwd === null) {
          return yield* new WorktreeCleanupError({
            detail: "This chat's copy was cleaned up and its project folder is gone, so it can't come back",
          });
        }
        const ref = savedRefFor(thread.id);
        const hasSnapshot = ref !== null && (yield* refExists(deps.git, repoCwd, ref));
        const base = hasSnapshot && ref !== null ? yield* snapshotBase(deps.git, repoCwd, ref) : null;
        const created = yield* recreateWorktree(deps.git, {
          repoCwd,
          worktreePath,
          branch,
          startPoint: base,
        }).pipe(
          Effect.mapError(
            (error) =>
              new WorktreeCleanupError({
                detail: `Couldn't bring back this chat's copy on ${branch}: ${error.message}`,
                cause: error,
              }),
          ),
        );
        const filesDir = savedFilesDir(thread.id);
        const restore = Effect.gen(function* () {
          const restored = hasSnapshot && ref !== null
            ? yield* restoreSnapshot(deps.git, worktreePath, ref)
            : ("none" as const);
          const envFiles = filesDir === null ? 0 : yield* restoreEnvFiles(filesDir, worktreePath);
          return { restored, envFiles };
        });
        // A half-done restore is undone so the next message tries again from
        // the saved copies, which are only dropped once everything is back.
        const result = yield* restore.pipe(
          Effect.tapError(() =>
            removeWorktree(deps.git, repoCwd, worktreePath, true).pipe(Effect.ignore),
          ),
          Effect.mapError(
            (error) =>
              new WorktreeCleanupError({
                detail: `Couldn't restore this chat's saved changes: ${error.message}`,
                cause: error,
              }),
          ),
        );
        if (result.restored === "restored" && ref !== null) {
          yield* deleteRef(deps.git, repoCwd, ref);
        }
        if (filesDir !== null) yield* removeSavedFiles(filesDir);
        if (result.restored === "conflict") {
          yield* Effect.logWarning(
            "worktree cleanup: saved changes don't apply to the branch any more; kept at the ref",
            { threadId, worktreePath, ref },
          );
        }
        yield* Effect.logInfo("worktree cleanup brought a chat copy back", {
          threadId,
          worktreePath,
          branch,
          branchCreated: created.branchCreated,
          restoredChanges: result.restored,
          restoredEnvFiles: result.envFiles,
        });
      }),
    );
  });

  const prepareTerminal: WorktreeCleanupShape["prepareTerminal"] = (input) =>
    Effect.gen(function* () {
      if (input.worktreePath == null) return;
      const thread = yield* deps.getThread(input.threadId);
      if (thread?.worktreePath == null || !sameResolved(thread.worktreePath, input.worktreePath)) {
        return;
      }
      yield* ensureThreadWorktree(input.threadId);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("worktree cleanup: couldn't bring a copy back for a terminal", {
          threadId: input.threadId,
          error: error.message,
        }),
      ),
    );

  let measured: { readonly at: number; readonly value: ChatCopiesOnDisk } | null = null;
  const copiesOnDisk = Effect.gen(function* () {
    if (measured !== null && now() - measured.at < COPIES_MEASURE_TTL_MS) return measured.value;
    const root = yield* realPathOrNull(deps.worktreesDir);
    const repos = root === null ? [] : yield* listDirectories(root);
    let copies = 0;
    for (const repo of repos) copies += (yield* listDirectories(repo)).length;
    const value: ChatCopiesOnDisk = {
      worktreesDir: deps.worktreesDir,
      copies,
      bytes: root === null ? 0 : yield* measureFolderBytes(root),
    };
    measured = { at: now(), value };
    return value;
  });

  const lastPassLowDisk = Effect.map(Ref.get(reportRef), (report) => ({
    lowDisk: report?.lowDisk ?? false,
    at: report === null ? 0 : Date.parse(report.finishedAt),
  }));

  const start: WorktreeCleanupShape["start"] = () =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const pending = new Set<string>();
      /** A pass `delay` from now, unless one with the same delay is already waiting. */
      const passAfter = (delay: Duration.Duration) => {
        const key = Duration.toMillis(delay).toString();
        if (pending.has(key)) return Effect.void;
        pending.add(key);
        return Effect.sleep(delay).pipe(
          Effect.andThen(Effect.sync(() => pending.delete(key))),
          Effect.andThen(requestPass),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      };
      yield* Effect.sleep(FIRST_PASS_DELAY).pipe(
        Effect.andThen(
          requestPass.pipe(Effect.andThen(worker.drain), Effect.repeat(Schedule.spaced(PASS_INTERVAL))),
        ),
        Effect.forkScoped,
      );
      yield* Effect.gen(function* () {
        const space = yield* deps.diskSpace(deps.worktreesDir);
        if (!isLowDisk(space)) return;
        const last = yield* lastPassLowDisk;
        if (!last.lowDisk || now() - last.at > LOW_DISK_REPASS_MS) yield* requestPass;
      }).pipe(
        Effect.delay(DISK_CHECK_INTERVAL),
        Effect.repeat(Schedule.spaced(DISK_CHECK_INTERVAL)),
        Effect.forkScoped,
      );
      if (deps.domainEvents !== undefined) {
        yield* Stream.runForEach(deps.domainEvents, (event) => {
          if (event.type === "thread.deleted") return passAfter(AFTER_DELETE_DELAY);
          if (event.type === "thread.settled" || event.type === "thread.archived") {
            return passAfter(AFTER_SETTLE_DELAY);
          }
          return Effect.void;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree cleanup event stream failed", { cause }),
          ),
          Effect.forkScoped,
        );
      }
    });

  return {
    runNow,
    status: Effect.gen(function* () {
      return {
        report: yield* Ref.get(reportRef),
        worktreesDir: deps.worktreesDir,
        running: yield* Ref.get(runningRef),
      };
    }),
    ensureThreadWorktree,
    prepareTerminal,
    start,
    copiesOnDisk,
    drain: worker.drain,
  } satisfies WorktreeCleanupShape;
});

const toCleanupError = (detail: string) => (cause: unknown) =>
  new WorktreeCleanupError({ detail, cause });

export const WorktreeCleanupLive = Layer.effect(
  WorktreeCleanup,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const projections = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const providers = yield* ProviderService;
    const terminals = yield* TerminalManager;
    const git = yield* GitVcsDriver;
    const engine = yield* OrchestrationEngineService;

    const readThreads = Effect.gen(function* () {
      const snapshot = yield* projections
        .getShellSnapshot()
        .pipe(Effect.mapError(toCleanupError("Couldn't read the chats")));
      const deletedRows = yield* sql<{
        readonly threadId: string;
        readonly title: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly workspaceRoot: string;
      }>`
        SELECT
          t.thread_id AS "threadId",
          t.title,
          t.branch,
          t.worktree_path AS "worktreePath",
          p.workspace_root AS "workspaceRoot"
        FROM projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NOT NULL AND t.worktree_path IS NOT NULL
      `.pipe(Effect.mapError(toCleanupError("Couldn't read the deleted chats")));
      return {
        projects: snapshot.projects.map((project) => ({
          id: project.id,
          workspaceRoot: project.workspaceRoot,
        })),
        threads: snapshot.threads,
        deleted: deletedRows.map((row) => ({
          id: row.threadId,
          title: row.title,
          branch: row.branch,
          worktreePath: row.worktreePath,
          workspaceRoot: row.workspaceRoot,
        })),
      } satisfies CleanupThreadsSnapshot;
    });

    return yield* makeWorktreeCleanup({
      worktreesDir: config.worktreesDir,
      savedDir: nodePath.join(config.baseDir, "saved-worktrees"),
      tempDir: config.tempDir,
      git: git.execute,
      settings: settingsService.getSettings.pipe(
        Effect.map((settings) => settings.storageCleanup),
        // Unreadable settings: nothing goes.
        Effect.orElseSucceed(() => ({
          worktreeOnDelete: false,
          worktreeSettledAfterDays: null,
          worktreeAfterDays: null,
          worktreeLowDisk: false,
          worktreeSaveChanges: true,
        })),
      ),
      readThreads,
      getThread: (threadId) =>
        projections.getThreadShellById(ThreadId.make(threadId)).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        ),
      getProject: (projectId) =>
        projections.getProjectShellById(ProjectId.make(projectId)).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        ),
      liveSessions: providers.listSessions(),
      terminals: terminals.listSessions(),
      diskSpace: (target) => Effect.promise(() => diskSpaceAt(target).catch(() => null)),
      domainEvents: engine.streamDomainEvents,
    });
  }),
);
