import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerActionProposalRepositoryLive } from "../persistence/Layers/ManagerActionProposals.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { RemindersRepositoryLive } from "../persistence/Layers/Reminders.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  type ProjectionPendingApproval,
  ProjectionPendingApprovalRepository,
} from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ManagerApprovalServiceLive } from "./Layers/ManagerApprovalService.ts";
import { ManagerBudgetServiceLive } from "./Layers/ManagerBudgetService.ts";
import { ManagerTokenAuthServiceLive } from "./Layers/ManagerTokenAuth.ts";
import { ManagerToolServiceLive } from "./Layers/ManagerToolService.ts";
import { MANAGER_MCP_TOOLS } from "./mcp.ts";
import { ManagerTokenAuthService } from "./Services/ManagerTokenAuth.ts";
import { ManagerToolService } from "./Services/ManagerToolService.ts";
import {
  evaluateThreadWait,
  eventTouchesThreads,
  findTurnReply,
  shouldHoldForReply,
  WAIT_EVENT_DEBOUNCE_MS,
  WAIT_FALLBACK_POLL_MS,
  WAIT_REPLY_GRACE_MS,
  WAIT_STALE_INFLIGHT_MS,
  type WaitTurnRow,
} from "./threadWait.ts";

// TestClock starts at the epoch: keep every timestamp in that frame.
const iso = (ms: number) => new Date(ms).toISOString();

const turnRow = (overrides: Partial<WaitTurnRow>): WaitTurnRow => ({
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: iso(0),
  startedAt: iso(0),
  completedAt: iso(1_000),
  assistantMessageId: null,
  checkpointStatus: null,
  checkpointFiles: [],
  ...overrides,
});

describe("evaluateThreadWait", () => {
  const base = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    turns: [],
    nowMs: 10_000,
  } as const;

  it("is not settled while the session runs or a turn start is queued", () => {
    expect(
      evaluateThreadWait({
        ...base,
        session: { status: "running", updatedAt: iso(0), lastError: null },
        turns: [turnRow({})],
      }).settled,
    ).toBe(false);
    expect(
      evaluateThreadWait({
        ...base,
        session: { status: "ready", updatedAt: iso(0), lastError: null },
        turns: [turnRow({}), turnRow({ turnId: null, state: "pending", requestedAt: iso(5_000) })],
      }).settled,
    ).toBe(false);
  });

  it("reports the latest turn's terminal state", () => {
    const completed = evaluateThreadWait({ ...base, turns: [turnRow({})] });
    expect(completed).toMatchObject({ settled: true, status: "completed" });
    const errored = evaluateThreadWait({
      ...base,
      turns: [
        turnRow({ requestedAt: iso(0) }),
        turnRow({ turnId: TurnId.make("turn-2"), state: "error", requestedAt: iso(2_000) }),
      ],
    });
    expect(errored).toMatchObject({ settled: true, status: "error" });
    expect(
      evaluateThreadWait({ ...base, turns: [turnRow({ state: "interrupted" })] }),
    ).toMatchObject({ settled: true, status: "interrupted" });
    expect(evaluateThreadWait(base)).toMatchObject({ settled: true, status: "idle" });
  });

  it("needs_user wins over everything else", () => {
    expect(
      evaluateThreadWait({
        ...base,
        hasPendingUserInput: true,
        session: { status: "running", updatedAt: iso(0), lastError: null },
      }),
    ).toMatchObject({ settled: true, status: "needs_user" });
  });

  it("treats a session that died after the request as an error, a stale one as not", () => {
    const pending = turnRow({ turnId: null, state: "pending", requestedAt: iso(5_000) });
    expect(
      evaluateThreadWait({
        ...base,
        session: { status: "error", updatedAt: iso(6_000), lastError: "quota exceeded" },
        turns: [pending],
      }),
    ).toMatchObject({ settled: true, status: "error", error: "quota exceeded" });
    expect(
      evaluateThreadWait({
        ...base,
        session: { status: "stopped", updatedAt: iso(1_000), lastError: null },
        turns: [pending],
      }).settled,
    ).toBe(false);
    // …unless nothing moves for too long: then the turn is reported as lost.
    expect(
      evaluateThreadWait({
        ...base,
        nowMs: 5_000 + WAIT_STALE_INFLIGHT_MS + 1,
        session: { status: "ready", updatedAt: iso(1_000), lastError: null },
        turns: [pending],
      }),
    ).toMatchObject({ settled: true, status: "error" });
  });

  it("holds a completed turn briefly while its final message lands", () => {
    const verdict = evaluateThreadWait({ ...base, turns: [turnRow({ completedAt: iso(1_000) })] });
    expect(shouldHoldForReply(verdict, null, 2_000)).toBe(true);
    expect(shouldHoldForReply(verdict, null, 1_000 + WAIT_REPLY_GRACE_MS + 1)).toBe(false);
    const reply = {
      id: "m",
      role: "assistant",
      text: "done",
      streaming: false,
      createdAt: iso(900),
    };
    expect(shouldHoldForReply(verdict, reply, 2_000)).toBe(false);
    expect(findTurnReply(turnRow({}), [reply])).toBe(reply);
  });

  it("filters events to the watched threads and skips streaming deltas", () => {
    const watched = new Set(["thread-a"]);
    expect(
      eventTouchesThreads(
        { type: "thread.session-set", aggregateId: "thread-a", payload: {} },
        watched,
      ),
    ).toBe(true);
    expect(
      eventTouchesThreads(
        { type: "thread.session-set", aggregateId: "thread-b", payload: {} },
        watched,
      ),
    ).toBe(false);
    expect(
      eventTouchesThreads(
        {
          type: "thread.message-sent",
          aggregateId: "thread-a",
          payload: { threadId: "thread-a", streaming: true },
        },
        watched,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service-level: the real ManagerToolService over in-memory sqlite turn rows,
// a controllable thread shell/detail and a hand-fed orchestration event bus.
// ---------------------------------------------------------------------------

const projectId = ProjectId.make("project-wait");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-4-6",
};

interface ThreadState {
  readonly session: OrchestrationSession | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly messages: OrchestrationThread["messages"];
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly approvals: ReadonlyArray<ProjectionPendingApproval>;
}

const idleState: ThreadState = {
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  messages: [],
  activities: [],
  approvals: [],
};

const session = (threadId: ThreadId, status: OrchestrationSession["status"], atMs: number) =>
  ({
    threadId,
    status,
    providerName: "claudeAgent",
    runtimeMode: "approval-required",
    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
    lastError: null,
    updatedAt: iso(atMs),
  }) satisfies OrchestrationSession;

const projectShell: OrchestrationProjectShell = {
  id: projectId,
  title: "wait",
  workspaceRoot: "/tmp/wait",
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: iso(0),
  updatedAt: iso(0),
};

const threadShell = (id: ThreadId, state: ThreadState): OrchestrationThreadShell => ({
  id,
  projectId,
  title: `Thread ${id}`,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: iso(0),
  updatedAt: iso(0),
  archivedAt: null,
  pinnedAt: null,
  session: state.session,
  latestUserMessageAt: null,
  hasPendingApprovals: state.hasPendingApprovals,
  hasPendingUserInput: state.hasPendingUserInput,
  hasActionableProposedPlan: false,
});

const threadDetail = (id: ThreadId, state: ThreadState): OrchestrationThread => ({
  ...threadShell(id, state),
  deletedAt: null,
  messages: state.messages,
  proposedPlans: [],
  activities: [...state.activities],
  checkpoints: [],
});

const makeWaitLayer = (
  states: Ref.Ref<ReadonlyMap<ThreadId, ThreadState>>,
  bus: PubSub.PubSub<OrchestrationEvent>,
) => {
  const stateOf = (threadId: ThreadId) =>
    Ref.get(states).pipe(Effect.map((all) => Option.fromNullishOr(all.get(threadId))));

  const engineMock = Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 1 }),
    get streamDomainEvents() {
      return Stream.fromPubSub(bus);
    },
  });
  const projectionMock = Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: () => Effect.succeed(Option.some(projectShell)),
    getThreadShellById: (threadId) =>
      stateOf(threadId).pipe(Effect.map(Option.map((state) => threadShell(threadId, state)))),
    getThreadDetailById: (threadId) =>
      stateOf(threadId).pipe(Effect.map(Option.map((state) => threadDetail(threadId, state)))),
  });
  const approvalsMock = Layer.mock(ProjectionPendingApprovalRepository)({
    listByThreadId: ({ threadId }) =>
      stateOf(threadId).pipe(
        Effect.map((state) => (Option.isSome(state) ? state.value.approvals : [])),
      ),
  });
  const repositories = Layer.mergeAll(
    ManagerActionProposalRepositoryLive,
    ManagerCapabilityTokenRepositoryLive,
    ManagerConnectorRepositoryLive,
    RemindersRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

  return Layer.mergeAll(ManagerToolServiceLive, ManagerTokenAuthServiceLive).pipe(
    Layer.provideMerge(ManagerApprovalServiceLive),
    Layer.provide(ManagerBudgetServiceLive),
    Layer.provideMerge(repositories),
    Layer.provide(approvalsMock),
    Layer.provide(engineMock),
    Layer.provide(projectionMock),
  );
};

const readCaller = Effect.gen(function* () {
  const tokenAuth = yield* ManagerTokenAuthService;
  const created = yield* tokenAuth.issueToken({
    label: "wait-test",
    scopes: ["threads:read"],
    projectAllowlist: [projectId],
    budget: null,
  });
  return yield* tokenAuth.authenticate(`Bearer ${created.token}`);
});

const runningTurn = (threadId: ThreadId) => ({
  threadId,
  turnId: TurnId.make("turn-1"),
  pendingMessageId: null,
  sourceProposedPlanThreadId: null,
  sourceProposedPlanId: null,
  assistantMessageId: null,
  state: "running" as const,
  requestedAt: iso(0),
  startedAt: iso(0),
  completedAt: null,
  checkpointTurnCount: null,
  checkpointRef: null,
  checkpointStatus: null,
  checkpointFiles: [],
});

const completedTurn = (threadId: ThreadId, completedAtMs: number) => ({
  ...runningTurn(threadId),
  state: "completed" as const,
  assistantMessageId: MessageId.make(`reply-${threadId}`),
  completedAt: iso(completedAtMs),
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make("refs/t3/checkpoints/1"),
  checkpointStatus: "ready" as const,
  checkpointFiles: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
});

const replyMessage = (threadId: ThreadId, text: string) => ({
  id: MessageId.make(`reply-${threadId}`),
  role: "assistant" as const,
  text,
  turnId: TurnId.make("turn-1"),
  streaming: false,
  createdAt: iso(1),
  updatedAt: iso(1),
});

const sessionSetEvent = (threadId: ThreadId) =>
  ({
    type: "thread.session-set",
    aggregateId: threadId,
    payload: { threadId },
  }) as unknown as OrchestrationEvent;

/** Real-time pause so the waiter fiber reaches its blocking point. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

it.layer(NodeServices.layer)("wait_for_thread", (it) => {
  it.effect("returns the result when the running turn completes (event-driven)", () =>
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadState>>(
        new Map([[threadA, { ...idleState, session: session(threadA, "running", 0) }]]),
      );
      const bus = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const turns = yield* ProjectionTurnRepository;
        const caller = yield* readCaller;
        yield* turns.upsertByTurnId(runningTurn(threadA));

        const waiter = yield* tools
          .waitForThread(caller, { threadId: threadA, timeoutSec: 60 })
          .pipe(Effect.forkChild);
        yield* settle;

        const longReply = `All tests pass.\n${"x".repeat(5_000)}`;
        yield* turns.upsertByTurnId(completedTurn(threadA, 2));
        yield* Ref.set(
          states,
          new Map([
            [
              threadA,
              {
                ...idleState,
                session: session(threadA, "ready", 2),
                messages: [replyMessage(threadA, longReply)],
              },
            ],
          ]),
        );
        yield* PubSub.publish(bus, sessionSetEvent(threadA));
        yield* settle;
        yield* TestClock.adjust(WAIT_EVENT_DEBOUNCE_MS);

        const result = yield* Fiber.join(waiter);
        expect(result.status).toBe("completed");
        expect(result.settledImmediately).toBe(false);
        expect(result.turnId).toBe("turn-1");
        expect(result.lastAssistantMessage).toContain("<untrusted_thread_output>All tests pass.");
        expect(result.lastAssistantMessageTruncated).toBe(true);
        expect(result.lastAssistantMessage!.length).toBeLessThan(4_100);
        expect(result.changedFiles).toEqual([
          { path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 },
        ]);
        expect(result.changedFilesTotal).toBe(1);
        expect(result.turnDurationMs).toBe(2);
        // Woken by the event, well before the fallback poll.
        expect(result.waitedMs).toBeLessThan(WAIT_FALLBACK_POLL_MS);
      }).pipe(Effect.provide(makeWaitLayer(states, bus)));
    }),
  );

  it.effect("falls back to the rare poll when no event arrives", () =>
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadState>>(
        new Map([[threadA, { ...idleState, session: session(threadA, "running", 0) }]]),
      );
      const bus = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const turns = yield* ProjectionTurnRepository;
        const caller = yield* readCaller;
        yield* turns.upsertByTurnId(runningTurn(threadA));

        const waiter = yield* tools
          .waitForThread(caller, { threadId: threadA, timeoutSec: 60 })
          .pipe(Effect.forkChild);
        yield* settle;
        yield* turns.upsertByTurnId(completedTurn(threadA, 2));
        yield* Ref.set(
          states,
          new Map([
            [
              threadA,
              {
                ...idleState,
                session: session(threadA, "ready", 2),
                messages: [replyMessage(threadA, "done")],
              },
            ],
          ]),
        );
        yield* TestClock.adjust(WAIT_FALLBACK_POLL_MS + WAIT_EVENT_DEBOUNCE_MS);
        const result = yield* Fiber.join(waiter);
        expect(result.status).toBe("completed");
        expect(result.lastAssistantMessage).toContain("done");
      }).pipe(Effect.provide(makeWaitLayer(states, bus)));
    }),
  );

  it.effect("times out while the turn keeps running", () =>
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadState>>(
        new Map([[threadA, { ...idleState, session: session(threadA, "running", 0) }]]),
      );
      const bus = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const turns = yield* ProjectionTurnRepository;
        const caller = yield* readCaller;
        yield* turns.upsertByTurnId(runningTurn(threadA));

        const waiter = yield* tools
          .waitForThread(caller, { threadId: threadA, timeoutSec: 5 })
          .pipe(Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust("6 seconds");
        const result = yield* Fiber.join(waiter);
        expect(result.status).toBe("timeout");
        expect(result.waitedMs).toBe(5_000);
        expect(result.lastAssistantMessage).toBeNull();
      }).pipe(Effect.provide(makeWaitLayer(states, bus)));
    }),
  );

  it.effect("returns needs_user with the pending approval and what is asked", () =>
    Effect.gen(function* () {
      const approval: ProjectionPendingApproval = {
        requestId: ApprovalRequestId.make("req-1"),
        threadId: threadA,
        turnId: TurnId.make("turn-1"),
        status: "pending",
        decision: null,
        createdAt: iso(1),
        resolvedAt: null,
      };
      const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadState>>(
        new Map([
          [
            threadA,
            {
              ...idleState,
              session: session(threadA, "running", 0),
              hasPendingApprovals: true,
              approvals: [approval],
              activities: [
                {
                  id: EventId.make("activity-1"),
                  tone: "approval",
                  kind: "approval.requested",
                  summary: "Run command",
                  payload: { detail: "rm -rf build" },
                  turnId: TurnId.make("turn-1"),
                  createdAt: iso(1),
                },
              ],
            },
          ],
        ]),
      );
      const bus = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const turns = yield* ProjectionTurnRepository;
        const caller = yield* readCaller;
        yield* turns.upsertByTurnId(runningTurn(threadA));

        const result = yield* tools.waitForThread(caller, { threadId: threadA });
        expect(result.status).toBe("needs_user");
        expect(result.settledImmediately).toBe(true);
        expect(result.pendingApprovals.map((entry) => entry.requestId)).toEqual(["req-1"]);
        expect(result.pendingRequest).toContain("Run command");
        expect(result.pendingRequest).toContain("rm -rf build");
      }).pipe(Effect.provide(makeWaitLayer(states, bus)));
    }),
  );

  it.effect("wait_for_threads mode any returns once one thread settles", () =>
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<ThreadId, ThreadState>>(
        new Map([
          [threadA, { ...idleState, session: session(threadA, "running", 0) }],
          [threadB, { ...idleState, session: session(threadB, "running", 0) }],
        ]),
      );
      const bus = yield* PubSub.unbounded<OrchestrationEvent>();
      yield* Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const turns = yield* ProjectionTurnRepository;
        const caller = yield* readCaller;
        yield* turns.upsertByTurnId(runningTurn(threadA));
        yield* turns.upsertByTurnId(runningTurn(threadB));

        const waiter = yield* tools
          .waitForThreads(caller, { threadIds: [threadA, threadB], mode: "any", timeoutSec: 60 })
          .pipe(Effect.forkChild);
        yield* settle;
        yield* turns.upsertByTurnId(completedTurn(threadB, 2));
        yield* Ref.update(states, (all) =>
          new Map(all).set(threadB, {
            ...idleState,
            session: session(threadB, "ready", 2),
            messages: [replyMessage(threadB, "B done")],
          }),
        );
        yield* PubSub.publish(bus, sessionSetEvent(threadB));
        yield* settle;
        yield* TestClock.adjust(WAIT_EVENT_DEBOUNCE_MS);

        const result = yield* Fiber.join(waiter);
        expect(result.mode).toBe("any");
        expect(result.timedOut).toBe(false);
        expect(result.results.map((entry) => [entry.threadId, entry.status])).toEqual([
          [threadA, "running"],
          [threadB, "completed"],
        ]);
      }).pipe(Effect.provide(makeWaitLayer(states, bus)));
    }),
  );

  it.effect("exposes wait_for_thread and wait_for_threads over MCP", () =>
    Effect.sync(() => {
      const names = MANAGER_MCP_TOOLS.map((tool) => tool.name);
      expect(names).toContain("wait_for_thread");
      expect(names).toContain("wait_for_threads");
    }),
  );
});
