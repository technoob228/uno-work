/**
 * `/use`, `/thread`, `/assistant`, `/where`, `/threads`, `/approve`, `/deny`
 * driven against in-memory fakes of the binding repository, the projection
 * read model and the orchestration engine — the same shape of harness the
 * manager tool tests use, without SQLite.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ManagerConnectorBinding,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionPendingApproval } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { telegramCommandOrigin } from "../orchestration/commandOrigin.ts";
import {
  executeConnectorCommand,
  type ConnectorCommandContext,
  type ConnectorCommandDeps,
} from "./connectorCommandHandler.ts";
import type { ConnectorCommand } from "./connectorCommands.ts";

const assistantId = ProjectId.make("assistant-home");
const apiProjectId = ProjectId.make("project-api");
const webProjectId = ProjectId.make("project-web");
const apiThreadId = ThreadId.make("thread-api-1");
const apiThread2Id = ThreadId.make("thread-api-2");
const webThreadId = ThreadId.make("thread-web-1");
const archivedThreadId = ThreadId.make("thread-archived");
const nowIso = "2026-09-11T10:00:00.000Z";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

const project = (id: ProjectId, title: string): OrchestrationProjectShell => ({
  id,
  title,
  workspaceRoot: `/tmp/${title}`,
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: nowIso,
  updatedAt: nowIso,
});

const thread = (
  id: ThreadId,
  projectId: ProjectId,
  title: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId,
  title,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  archivedAt: null,
  pinnedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

interface Harness {
  readonly deps: ConnectorCommandDeps;
  readonly bindings: Map<string, ManagerConnectorBinding>;
  readonly dispatched: Array<{
    command: OrchestrationCommand;
    origin?: OrchestrationCommandOrigin;
  }>;
}

const makeHarness = (input?: {
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly pending?: ReadonlyArray<ProjectionPendingApproval>;
  readonly bindings?: ReadonlyArray<ManagerConnectorBinding>;
}): Harness => {
  const bindings = new Map(
    (input?.bindings ?? []).map((binding) => [`${binding.kind}:${binding.chatId}`, binding]),
  );
  const dispatched: Harness["dispatched"] = [];
  const threads = input?.threads ?? [
    thread(apiThreadId, apiProjectId, "Fix billing", { updatedAt: "2026-09-11T09:00:00.000Z" }),
    thread(apiThread2Id, apiProjectId, "Add webhooks", {
      updatedAt: "2026-09-11T09:30:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: nowIso,
        startedAt: nowIso,
        completedAt: null,
        assistantMessageId: null,
      },
    }),
    thread(webThreadId, webProjectId, "Landing redesign"),
    thread(archivedThreadId, apiProjectId, "Old thread", { archivedAt: nowIso }),
  ];
  const pending = input?.pending ?? [];
  const deps: ConnectorCommandDeps = {
    bindings: {
      get: (key) =>
        Effect.succeed(Option.fromUndefinedOr(bindings.get(`${key.kind}:${key.chatId}`))),
      upsert: (row) =>
        Effect.sync(() => {
          bindings.set(`${row.kind}:${row.chatId}`, {
            kind: row.kind,
            chatId: row.chatId,
            connectorProjectId: row.connectorProjectId,
            target: row.target,
            notifyOnComplete: row.notifyOnComplete,
            updatedAt: row.updatedAt,
          });
        }),
      remove: (key) => Effect.sync(() => bindings.delete(`${key.kind}:${key.chatId}`)),
    },
    projections: {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            project(assistantId, "Assistant"),
            project(apiProjectId, "Uno API"),
            project(webProjectId, "Uno Web"),
          ],
          threads,
          updatedAt: nowIso,
        }),
    },
    pendingApprovals: {
      listByThreadId: ({ threadId }) =>
        Effect.succeed(pending.filter((row) => row.threadId === threadId)),
    },
    engine: {
      dispatch: (command, options) =>
        Effect.sync(() => {
          dispatched.push({ command, ...(options?.origin ? { origin: options.origin } : {}) });
          return { sequence: dispatched.length };
        }),
    },
    now: () => new Date(nowIso),
  };
  return { deps, bindings, dispatched };
};

const context: ConnectorCommandContext = {
  kind: "telegram",
  chatId: "100",
  connectorProjectId: assistantId,
  origin: telegramCommandOrigin("100"),
};

const run = (harness: Harness, command: ConnectorCommand) =>
  Effect.runPromise(executeConnectorCommand(harness.deps, context, command));

const pendingRow = (
  threadId: ThreadId,
  requestId: string,
  createdAt: string,
): ProjectionPendingApproval => ({
  requestId: ApprovalRequestId.make(requestId),
  threadId,
  turnId: null,
  status: "pending",
  decision: null,
  createdAt,
  resolvedAt: null,
});

describe("executeConnectorCommand", () => {
  it("/use binds the chat to a project by fuzzy title and /where reports it", async () => {
    const harness = makeHarness();
    const reply = await run(harness, { name: "use", query: "uno api" });
    expect(reply).toContain('project "Uno API"');
    expect(harness.bindings.get("telegram:100")).toMatchObject({
      connectorProjectId: assistantId,
      target: { kind: "project", projectId: apiProjectId },
      notifyOnComplete: false,
    });
    expect(await run(harness, { name: "where" })).toBe(
      `Bound to project "Uno API" [${apiProjectId}]. Completion notifications: off.`,
    );
  });

  it("/use lists candidates on ambiguity and available projects on no match, without binding", async () => {
    const harness = makeHarness();
    const ambiguous = await run(harness, { name: "use", query: "uno" });
    expect(ambiguous).toContain("Several projects match");
    expect(ambiguous).toContain("Uno API");
    expect(ambiguous).toContain("Uno Web");
    const none = await run(harness, { name: "use", query: "nothing" });
    expect(none).toContain('No project matches "nothing"');
    // Assistant projects are not offered.
    expect(none).not.toContain("Assistant [");
    expect(harness.bindings.size).toBe(0);
    expect(await run(harness, { name: "use", query: "" })).toContain("Usage: /use");
  });

  it("/thread binds to a live thread by id prefix and skips archived ones", async () => {
    const harness = makeHarness();
    const reply = await run(harness, { name: "thread", query: "thread-api-1" });
    expect(reply).toContain('thread "Fix billing"');
    expect(harness.bindings.get("telegram:100")?.target).toEqual({
      kind: "thread",
      threadId: apiThreadId,
    });
    expect(await run(harness, { name: "thread", query: "old thread" })).toContain(
      'No thread matches "old thread"',
    );
  });

  it("/assistant removes the binding and keeps the default", async () => {
    const harness = makeHarness({
      bindings: [
        {
          kind: "telegram",
          chatId: "100",
          connectorProjectId: assistantId,
          target: { kind: "project", projectId: apiProjectId },
          notifyOnComplete: true,
          updatedAt: nowIso,
        },
      ],
    });
    expect(await run(harness, { name: "assistant" })).toContain("assistant again");
    expect(harness.bindings.size).toBe(0);
    expect(await run(harness, { name: "where" })).toContain("Bound to the assistant (default)");
  });

  it("/threads lists live threads of the bound project, newest first, with their state", async () => {
    const harness = makeHarness();
    await run(harness, { name: "use", query: "Uno API" });
    const reply = await run(harness, { name: "threads" });
    expect(reply.split("\n")).toEqual([
      'Live threads in "Uno API":',
      `- Add webhooks [${apiThread2Id}] - running`,
      `- Fix billing [${apiThreadId}] - idle`,
    ]);
    // For the assistant target it lists the assistant project's threads.
    await run(harness, { name: "assistant" });
    expect(await run(harness, { name: "threads" })).toBe('No live threads in "Assistant".');
  });

  it("/approve on a thread binding resolves the oldest pending request through the engine", async () => {
    const harness = makeHarness({
      pending: [
        pendingRow(apiThreadId, "req-new", "2026-09-11T09:05:00.000Z"),
        pendingRow(apiThreadId, "req-old", "2026-09-11T09:00:00.000Z"),
      ],
    });
    await run(harness, { name: "thread", query: "Fix billing" });
    expect(await run(harness, { name: "approve" })).toBe(
      'Approved the pending request in "Fix billing".',
    );
    expect(harness.dispatched).toEqual([
      {
        command: expect.objectContaining({
          type: "thread.approval.respond",
          threadId: apiThreadId,
          requestId: ApprovalRequestId.make("req-old"),
          decision: "accept",
        }),
        origin: telegramCommandOrigin("100"),
      },
    ]);
  });

  it("/deny on a project binding acts only when exactly one thread is pending", async () => {
    const pending = [
      pendingRow(apiThreadId, "req-a", "2026-09-11T09:00:00.000Z"),
      pendingRow(apiThread2Id, "req-b", "2026-09-11T09:01:00.000Z"),
    ];
    const threads = [
      thread(apiThreadId, apiProjectId, "Fix billing", { hasPendingApprovals: true }),
      thread(apiThread2Id, apiProjectId, "Add webhooks", { hasPendingApprovals: true }),
    ];
    const ambiguous = makeHarness({ pending, threads });
    await run(ambiguous, { name: "use", query: "Uno API" });
    const reply = await run(ambiguous, { name: "deny" });
    expect(reply).toContain("Several threads are waiting for approval");
    expect(reply).toContain("Fix billing");
    expect(ambiguous.dispatched).toEqual([]);

    const single = makeHarness({
      pending: [pending[0]!],
      threads: [threads[0]!, thread(apiThread2Id, apiProjectId, "Add webhooks")],
    });
    await run(single, { name: "use", query: "Uno API" });
    expect(await run(single, { name: "deny" })).toBe(
      'Declined the pending request in "Fix billing".',
    );
    expect(single.dispatched[0]?.command).toMatchObject({
      type: "thread.approval.respond",
      requestId: ApprovalRequestId.make("req-a"),
      decision: "decline",
    });

    const idle = makeHarness({ threads });
    await run(idle, { name: "use", query: "Uno API" });
    expect(await run(idle, { name: "approve" })).toBe("Nothing is waiting for approval.");
  });

  it("/approve is refused for the assistant target", async () => {
    const harness = makeHarness({ pending: [pendingRow(apiThreadId, "req-a", nowIso)] });
    expect(await run(harness, { name: "approve" })).toContain("only for a bound project or thread");
    expect(harness.dispatched).toEqual([]);
  });

  it("turns storage failures into a reply instead of failing the update", async () => {
    const harness = makeHarness();
    const failing: ConnectorCommandDeps = {
      ...harness.deps,
      bindings: {
        ...harness.deps.bindings,
        upsert: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "ManagerConnectorBindingRepository.upsert:query",
              detail: "disk full",
            }),
          ),
      },
    };
    const reply = await Effect.runPromise(
      executeConnectorCommand(failing, context, { name: "use", query: "Uno API" }),
    );
    expect(reply).toBe(
      "Command failed: SQL error in ManagerConnectorBindingRepository.upsert:query: disk full",
    );
  });
});
