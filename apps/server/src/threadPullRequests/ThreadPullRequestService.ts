/**
 * ThreadPullRequestService — in Dev mode a chat knows its pull request: the row
 * in its details, and it settles by itself after the merge.
 *
 * Reads go through the source-control providers the person already connected
 * (`gh`, `glab`), as one document per repository. A sweep runs every minute
 * while a client is connected, plus once after every turn and right after an
 * agent's `gh pr merge`. Nothing here runs without Dev mode, so people who
 * aren't developers spend no GitHub limit and see no change.
 *
 * Upstream does this with PullRequestSyncReactor and ThreadPullRequestService
 * on orchestration v2; this is the same logic over our domain events. The rules
 * are in threadPullRequestRules.ts, the reading of shell commands in
 * commandDetection.ts.
 *
 * @module threadPullRequests/ThreadPullRequestService
 */
import {
  CommandId,
  type ChangeRequestStatus,
  type OrchestrationEvent,
  type SourceControlProviderKind,
  ThreadId,
  type ThreadPullRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseRemoteRepositoryPath } from "@t3tools/shared/sourceControl";
import type { Scope } from "effect";
import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MAX_STATUS_READS_PER_DOCUMENT } from "../sourceControl/gitHubPullRequestStatuses.ts";
import type { SourceControlProviderHandle } from "../sourceControl/SourceControlProviderRegistry.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { changeRequestsCreatedBy, closesChangeRequest, shellCallOf } from "./commandDetection.ts";
import { makeThreadPullRequestRepository } from "./threadPullRequestRepository.ts";
import {
  applyRead,
  branchKey,
  branchReadInterval,
  capLinks,
  isBranchWorthAsking,
  isRateLimited,
  isReadDue,
  linkKey,
  linkReadInterval,
  PAUSE_AFTER_FAILURE_MS,
  pauseForBudget,
  shouldAutoSettle,
  SWEEP_INTERVAL_MS,
  type SweepThread,
} from "./threadPullRequestRules.ts";

const COMPONENT = "thread-pull-requests";
/** A remote rarely changes; `git remote` for every project every minute adds up. */
const REPOSITORY_INFO_TTL_MS = 10 * 60_000;
/** More than this many documents for one repository wait for the next sweep. */
const MAX_DOCUMENTS_PER_SWEEP = 3;
const PROJECT_CONCURRENCY = 3;

interface RepositoryInfo {
  readonly handle: SourceControlProviderHandle;
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
  readonly defaultBranch: string | null;
}

interface ReadPlan {
  readonly numbers: Set<number>;
  readonly branches: Set<string>;
}

export interface ThreadPullRequestsShape {
  /** Watch the chats and run the minute sweep. Must run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadPullRequests extends Context.Service<
  ThreadPullRequests,
  ThreadPullRequestsShape
>()("t3/threadPullRequests/ThreadPullRequestService") {}

export interface ThreadPullRequestsOptions {
  /** Tests: the clock. */
  readonly now?: () => number;
}

type WorkItem =
  | { readonly kind: "tick" }
  | { readonly kind: "requested" }
  | {
      readonly kind: "created";
      readonly threadId: string;
      readonly created: ReturnType<typeof changeRequestsCreatedBy>;
    };

const chunks = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
  const result: Array<ReadonlyArray<T>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
};

export const makeThreadPullRequests = (options: ThreadPullRequestsOptions = {}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const sourceControl = yield* SourceControlProviderRegistry;
    const sessions = yield* SessionCredentialService;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const projectScripts = yield* ProjectSetupScriptRunner;
    const repository = yield* makeThreadPullRequestRepository;
    const nowMs = options.now ?? Date.now;

    /** `linkKey` / `branchKey` → when the host last answered about it. */
    const lastReadAt = new Map<string, number>();
    const requestedThreads = new Set<string>();
    let requestedSweepQueued = false;
    // A sweep that outlasts the minute (slow host) must not pile up ticks.
    let tickQueued = false;
    /** A repeated `thread.settled` keeps its time; the action runs once per settle. */
    const settleActionRunAt = new Map<string, string>();
    /** `kind:host` or `kind:host/repository` → until when we don't ask. */
    const pausedUntil = new Map<string, number>();
    const repositoryInfo = new Map<
      string,
      { readonly atMs: number; readonly info: RepositoryInfo | null }
    >();

    const readSettings = settings.getSettings.pipe(
      Effect.map((current) => ({
        devMode: current.devMode,
        // The switch can differ per project (Settings → Source Control).
        autoSettleOnMerge: (projectId: string) =>
          resolveProjectSettings(current, projectId).settings.sidebarAutoSettleOnMerge,
      })),
      // A hiccup reading the settings must not spend the person's limits.
      Effect.orElseSucceed(() => ({ devMode: false, autoSettleOnMerge: () => false })),
    );

    const anyClientConnected = sessions.listActive().pipe(
      Effect.map((rows) => rows.some((row) => row.connected)),
      Effect.orElseSucceed(() => false),
    );

    const defaultBranchOf = (cwd: string) =>
      vcsProcess
        .run({
          operation: "ThreadPullRequests.defaultBranch",
          command: "git",
          args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => {
            const name = result.stdout.trim().replace(/^origin\//u, "");
            return result.exitCode === 0 && name.length > 0 ? name : null;
          }),
          Effect.orElseSucceed(() => null),
        );

    const readRepositoryInfo = (projectId: string, cwd: string) =>
      Effect.gen(function* () {
        const cached = repositoryInfo.get(projectId);
        if (cached !== undefined && nowMs() - cached.atMs < REPOSITORY_INFO_TTL_MS) {
          return cached.info;
        }
        const handle = yield* sourceControl.resolveHandle({ cwd }).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<SourceControlProviderHandle>()),
        );
        const context = Option.getOrNull(handle)?.context ?? null;
        const path = context === null ? null : parseRemoteRepositoryPath(context.remoteUrl);
        const info: RepositoryInfo | null =
          Option.isSome(handle) &&
          context !== null &&
          path !== null &&
          handle.value.provider.readChangeRequestStatuses !== undefined
            ? {
                handle: handle.value,
                kind: context.provider.kind,
                host: new URL(context.provider.baseUrl).hostname,
                repository: path,
                defaultBranch: yield* defaultBranchOf(cwd),
              }
            : null;
        repositoryInfo.set(projectId, { atMs: nowMs(), info });
        return info;
      });

    const isPaused = (key: string) => (pausedUntil.get(key) ?? 0) > nowMs();

    /** The links and branches this project should ask about now. */
    const planReads = (
      threads: ReadonlyArray<SweepThread>,
      info: RepositoryInfo,
      requested: ReadonlySet<string>,
    ) => {
      const plans = new Map<string, ReadPlan>();
      const planFor = (name: string) => {
        const existing = plans.get(name);
        if (existing !== undefined) return existing;
        const plan: ReadPlan = { numbers: new Set(), branches: new Set() };
        plans.set(name, plan);
        return plan;
      };
      const deferred = new Set<string>();
      const now = nowMs();
      for (const thread of threads) {
        const wanted = requested.has(thread.threadId);
        for (const link of thread.pullRequests) {
          if (link.provider !== info.kind) continue;
          const key = linkKey(link);
          const open = link.snapshot === null || link.snapshot.state !== "merged";
          const due = isReadDue({
            intervalMs: linkReadInterval(link, now),
            lastReadMs: lastReadAt.get(key),
            requested: wanted && open,
            nowMs: now,
          });
          if (due) planFor(link.repository).numbers.add(link.number);
          else if (wanted && open) deferred.add(thread.threadId);
        }
        const branch = thread.branch;
        const hasOpenLink = thread.pullRequests.some((link) => link.snapshot?.state === "open");
        if (
          branch === null ||
          hasOpenLink ||
          isTemporaryWorktreeBranch(branch) ||
          !isBranchWorthAsking(branch, info.defaultBranch)
        ) {
          continue;
        }
        const due = isReadDue({
          intervalMs: branchReadInterval(thread, now),
          lastReadMs: lastReadAt.get(branchKey(info.repository, branch)),
          requested: wanted,
          nowMs: now,
        });
        if (due) planFor(info.repository).branches.add(branch);
        else if (wanted) deferred.add(thread.threadId);
      }
      return { plans, deferred };
    };

    /** One document per repository, a few when a sweep has a lot to ask. */
    const readPlan = (info: RepositoryInfo, repositoryName: string, plan: ReadPlan, cwd: string) =>
      Effect.gen(function* () {
        const read = info.handle.provider.readChangeRequestStatuses;
        if (read === undefined) return null;
        const statuses = new Map<string, ChangeRequestStatus>();
        const branchStatuses = new Map<string, ReadonlyArray<ChangeRequestStatus>>();
        const items = [
          ...[...plan.numbers].map((number) => ({ number })),
          ...[...plan.branches].map((branch) => ({ branch })),
        ];
        const documents = chunks(items, MAX_STATUS_READS_PER_DOCUMENT).slice(
          0,
          MAX_DOCUMENTS_PER_SWEEP,
        );
        for (const document of documents) {
          const numbers = document.flatMap((item) => ("number" in item ? [item.number] : []));
          const branches = document.flatMap((item) => ("branch" in item ? [item.branch] : []));
          const answer = yield* read({ cwd, repository: repositoryName, numbers, branches });
          const at = nowMs();
          for (const number of numbers) {
            lastReadAt.set(linkKey({ repository: repositoryName, number }), at);
            const status = answer.byNumber.get(number);
            if (status !== undefined) {
              statuses.set(linkKey({ repository: repositoryName, number }), status);
            }
          }
          for (const branch of branches) {
            lastReadAt.set(branchKey(repositoryName, branch), at);
            branchStatuses.set(branch, answer.byBranch.get(branch) ?? []);
          }
          const pause = pauseForBudget(answer.budget, at);
          if (pause !== null) {
            pausedUntil.set(`${info.kind}:${info.host}`, pause.pauseUntilMs);
            yield* Effect.logInfo(
              "pull request sync: pausing to leave the host's limit alone",
            ).pipe(Effect.annotateLogs({ host: info.host, remaining: answer.budget?.remaining }));
            break;
          }
        }
        return { statuses, branchStatuses };
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // A limit or a missing login is the whole host; a gone repository is only itself.
            const hostWide =
              isRateLimited(error.detail) || /auth|logged in|required but not/iu.test(error.detail);
            const key = hostWide
              ? `${info.kind}:${info.host}`
              : `${info.kind}:${info.host}/${repositoryName}`;
            pausedUntil.set(key, nowMs() + PAUSE_AFTER_FAILURE_MS);
            yield* Effect.logWarning("pull request sync: read skipped").pipe(
              Effect.annotateLogs({ repository: repositoryName, detail: error.detail }),
            );
            return null;
          }),
        ),
      );

    const dispatchLinks = (threadId: string, pullRequests: ReadonlyArray<ThreadPullRequest>) => {
      const createdAt = new Date(nowMs()).toISOString();
      return engine
        .dispatch(
          {
            type: "thread.pull-requests.sync",
            commandId: CommandId.make(`${COMPONENT}:${threadId}:${crypto.randomUUID()}`),
            threadId: ThreadId.make(threadId),
            pullRequests,
            createdAt: createdAt as Extract<
              Parameters<typeof engine.dispatch>[0],
              { type: "thread.pull-requests.sync" }
            >["createdAt"],
          },
          { origin: systemCommandOrigin(COMPONENT, "sync") },
        )
        .pipe(Effect.asVoid);
    };

    const syncProject = (threads: ReadonlyArray<SweepThread>, requested: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const first = threads[0];
        if (first === undefined) return;
        const info = yield* readRepositoryInfo(first.projectId, first.workspaceRoot);
        if (info === null) return;
        if (isPaused(`${info.kind}:${info.host}`)) {
          for (const thread of threads) {
            if (requested.has(thread.threadId)) requestedThreads.add(thread.threadId);
          }
          return;
        }
        const { plans, deferred } = planReads(threads, info, requested);
        for (const threadId of deferred) requestedThreads.add(threadId);

        const statuses = new Map<string, ChangeRequestStatus>();
        const branchStatuses = new Map<string, ReadonlyArray<ChangeRequestStatus>>();
        for (const [name, plan] of plans) {
          if (isPaused(`${info.kind}:${info.host}/${name}`)) continue;
          if (isPaused(`${info.kind}:${info.host}`)) break;
          const read = yield* readPlan(info, name, plan, first.workspaceRoot);
          if (read === null) continue;
          for (const [key, status] of read.statuses) statuses.set(key, status);
          for (const [branch, found] of read.branchStatuses) branchStatuses.set(branch, found);
        }
        if (statuses.size === 0 && branchStatuses.size === 0) return;

        const now = new Date(nowMs()).toISOString();
        for (const thread of threads) {
          const next = applyRead({
            thread,
            read: {
              provider: info.kind,
              repository: info.repository,
              statuses,
              branchStatuses:
                thread.branch === null ? null : (branchStatuses.get(thread.branch) ?? null),
            },
            now,
          });
          if (next !== thread.pullRequests) yield* dispatchLinks(thread.threadId, next);
        }
      });

    /** Settled by hand or moving on: `thread.settle` refuses, and the next pass looks again. */
    const settleFinished = (
      threads: ReadonlyArray<SweepThread>,
      autoSettleOnMerge: (projectId: string) => boolean,
    ) =>
      Effect.forEach(
        threads.filter((thread) =>
          shouldAutoSettle({
            thread,
            autoSettleOnMerge: autoSettleOnMerge(thread.projectId),
            nowMs: nowMs(),
          }),
        ),
        (thread) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(thread.threadId);
            const shell = Option.getOrNull(yield* projections.getThreadShellById(threadId));
            if (shell === null) return;
            const status = shell.session?.status;
            if (
              status === "starting" ||
              status === "running" ||
              shell.session?.activeTurnId != null ||
              shell.hasPendingApprovals ||
              shell.hasPendingUserInput
            ) {
              return;
            }
            yield* engine.dispatch(
              {
                type: "thread.settle",
                commandId: CommandId.make(
                  `${COMPONENT}:settle:${thread.threadId}:${crypto.randomUUID()}`,
                ),
                threadId,
              },
              { origin: systemCommandOrigin(COMPONENT, "pull request merged") },
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logDebug("pull request sync: thread stays for now").pipe(
                    Effect.annotateLogs({ threadId: thread.threadId, cause: Cause.pretty(cause) }),
                  ),
            ),
          ),
        { discard: true },
      );

    const sweep = (scope: "tick" | "requested") =>
      Effect.gen(function* () {
        const current = yield* readSettings;
        if (!current.devMode) {
          requestedThreads.clear();
          return;
        }
        if (scope === "tick" && !(yield* anyClientConnected)) return;
        const requested = new Set(requestedThreads);
        requestedThreads.clear();
        if (scope === "requested" && requested.size === 0) return;

        const threads = yield* repository.list;
        const byProject = Map.groupBy(threads, (thread) => thread.projectId);
        yield* Effect.forEach(
          byProject.values(),
          (group) =>
            syncProject(group, requested).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("pull request sync: project skipped").pipe(
                      Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                    ),
              ),
            ),
          { concurrency: PROJECT_CONCURRENCY, discard: true },
        );
        yield* settleFinished(yield* repository.list, current.autoSettleOnMerge);
      });

    const linkCreated = (threadId: string, created: ReturnType<typeof changeRequestsCreatedBy>) =>
      Effect.gen(function* () {
        const thread = yield* repository.get(threadId);
        if (thread === null) return;
        const known = new Set(thread.pullRequests.map(linkKey));
        const added = created.filter((pullRequest) => !known.has(linkKey(pullRequest)));
        if (added.length === 0) return;
        const linkedAt = new Date(nowMs()).toISOString() as ThreadPullRequest["linkedAt"];
        yield* dispatchLinks(
          threadId,
          capLinks([
            ...thread.pullRequests,
            ...added.map(
              (pullRequest): ThreadPullRequest => ({
                provider: pullRequest.provider,
                repository: pullRequest.repository as ThreadPullRequest["repository"],
                number: pullRequest.number as ThreadPullRequest["number"],
                url: pullRequest.url,
                source: "created",
                linkedAt,
                snapshot: null,
              }),
            ),
          ]),
        );
      });

    const worker = yield* makeDrainableWorker((item: WorkItem) => {
      if (item.kind === "requested") requestedSweepQueued = false;
      if (item.kind === "tick") tickQueued = false;
      return (
        item.kind === "created"
          ? linkCreated(item.threadId, item.created).pipe(
              Effect.andThen(requestRead(item.threadId)),
            )
          : sweep(item.kind)
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("pull request sync failed").pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              ),
        ),
      );
    });

    /** Reads this thread's PRs soon, out of cadence; many at once go as one sweep. */
    const requestRead = (threadId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        requestedThreads.add(threadId);
        if (requestedSweepQueued) return Effect.void;
        requestedSweepQueued = true;
        return worker.enqueue({ kind: "requested" });
      });

    const tick = Effect.suspend(() => {
      if (tickQueued) return Effect.void;
      tickQueued = true;
      return worker.enqueue({ kind: "tick" });
    });

    /**
     * A project's "Run on settle" action, in the chat's own worktree: a shared
     * checkout may have other chats working in it, so it is left alone.
     */
    const runSettleAction = (threadId: string, settledAt: string) =>
      Effect.gen(function* () {
        if (settleActionRunAt.get(threadId) === settledAt) return;
        const shell = Option.getOrNull(
          yield* projections.getThreadShellById(ThreadId.make(threadId)),
        );
        if (shell === null || shell.worktreePath === null) return;
        settleActionRunAt.set(threadId, settledAt);
        yield* projectScripts.runForThread({
          threadId,
          projectId: shell.projectId,
          worktreePath: shell.worktreePath,
          trigger: "settle",
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("project action on settle failed").pipe(
                Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              ),
        ),
      );

    const onDomainEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
      if (event.type === "thread.settled") {
        return runSettleAction(event.payload.threadId, event.payload.settledAt);
      }
      if (event.type === "thread.session-set") {
        const status = event.payload.session.status;
        // The turn is over: the agent may have pushed, opened or merged something.
        return status === "ready" || status === "error"
          ? readSettings.pipe(
              Effect.flatMap(({ devMode }) =>
                devMode ? requestRead(event.payload.threadId) : Effect.void,
              ),
            )
          : Effect.void;
      }
      if (event.type !== "thread.activity-appended") return Effect.void;
      const call = shellCallOf(event.payload.activity);
      if (call === null) return Effect.void;
      const created = changeRequestsCreatedBy(call.command, call.output);
      const closes = closesChangeRequest(call.command);
      if (created.length === 0 && !closes) return Effect.void;
      const threadId = event.payload.threadId;
      return readSettings.pipe(
        Effect.flatMap(({ devMode }) => {
          if (!devMode) return Effect.void;
          return created.length > 0
            ? worker.enqueue({ kind: "created", threadId, created })
            : requestRead(threadId);
        }),
      );
    };

    const start: ThreadPullRequestsShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(Stream.runForEach(engine.streamDomainEvents, onDomainEvent));
        yield* Effect.forkScoped(
          tick.pipe(
            Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
            Effect.delay(Duration.seconds(15)),
          ),
        );
      });

    return { start, onDomainEvent, drain: worker.drain, tick };
  });

export const ThreadPullRequestsLive = Layer.effect(
  ThreadPullRequests,
  makeThreadPullRequests().pipe(Effect.map(({ start }) => ({ start }))),
);
