import {
  EventId,
  MessageId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { translateV2Command, translateV2Launch, V2_REFUSAL } from "./commands.ts";
import { deriveV2ShellStatus, toV2ShellSnapshot, toV2ThreadShell } from "./mapShell.ts";
import { deriveRuntimeRequests, toV2ThreadProjection } from "./mapThread.ts";

const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-29T10:00:01.000Z";
const T2 = "2026-10-29T10:00:02.000Z";
const T3 = "2026-10-29T10:00:03.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

const shell = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the login",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: T0,
  updatedAt: T1,
  archivedAt: null,
  pinnedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  createdAt: string,
  sequence: number,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind,
  summary: kind === "tool.completed" ? "Run tests" : kind,
  payload,
  turnId: TURN_ID,
  sequence,
  createdAt,
});

const thread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  ...shell(),
  latestTurn: {
    turnId: TURN_ID,
    state: "running",
    requestedAt: T0,
    startedAt: T0,
    completedAt: null,
    assistantMessageId: null,
  },
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("m-user"),
      role: "user",
      text: "please fix",
      turnId: TURN_ID,
      streaming: false,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: MessageId.make("m-assistant"),
      role: "assistant",
      text: "on it",
      turnId: TURN_ID,
      streaming: true,
      createdAt: T3,
      updatedAt: T3,
    },
  ],
  proposedPlans: [],
  activities: [
    activity("a1", "tool.completed", { itemType: "command_execution", detail: "bun test" }, T1, 1),
    activity(
      "a2",
      "approval.requested",
      { requestId: "req-1", requestKind: "command", detail: "rm -rf build" },
      T2,
      2,
    ),
  ],
  checkpoints: [],
  session: {
    threadId: THREAD_ID,
    status: "running",
    providerName: "claude",
    runtimeMode: "full-access",
    activeTurnId: TURN_ID,
    lastError: null,
    updatedAt: T2,
  },
  ...overrides,
});

describe("v2 shell mapping", () => {
  it("maps our image mode to default and keeps Work's sidebar state", () => {
    const row = toV2ThreadShell(
      shell({
        interactionMode: "image",
        pinnedAt: T1,
        snoozedUntil: T3,
        snoozedAt: T1,
        settledOverride: "settled",
        settledAt: T2,
        lastVisitedAt: T2,
      }),
    );
    expect(row).toMatchObject({
      interactionMode: "default",
      pinnedAt: T1,
      snoozedUntil: T3,
      settledOverride: "settled",
      settledAt: T2,
      lastVisitedAt: T2,
      status: "idle",
      pendingRuntimeRequest: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    });
  });

  it("shows agent-spawned and assistant chats as ordinary rows", () => {
    expect(toV2ThreadShell(shell({ spawnedByThreadId: ThreadId.make("parent") }))).toMatchObject({
      createdBy: "agent",
      creationSource: "mcp",
      lineage: { relationshipToParent: null },
    });
    expect(toV2ThreadShell(shell({ assistantRole: "chat" }))).toMatchObject({
      createdBy: "agent",
      creationSource: "server",
    });
  });

  it("puts archived chats into archivedThreads", () => {
    const snapshot = toV2ShellSnapshot({
      snapshotSequence: 7,
      projects: [],
      threads: [shell(), shell({ id: ThreadId.make("t-archived"), archivedAt: T2 })],
    });
    expect((snapshot["threads"] as unknown[]).length).toBe(1);
    expect((snapshot["archivedThreads"] as unknown[]).length).toBe(1);
  });

  it("derives status from session, turn and waiting requests", () => {
    const running = {
      session: shell().session,
      latestTurn: {
        turnId: TURN_ID,
        state: "running" as const,
        requestedAt: T0,
        startedAt: T0,
        completedAt: null,
        assistantMessageId: null,
      },
    };
    expect(deriveV2ShellStatus({ ...running, waitingOnUser: false })).toBe("running");
    expect(deriveV2ShellStatus({ ...running, waitingOnUser: true })).toBe("waiting");
    expect(
      deriveV2ShellStatus({
        session: null,
        latestTurn: { ...running.latestTurn, state: "error" },
        waitingOnUser: false,
      }),
    ).toBe("failed");
  });
});

describe("v2 thread projection mapping", () => {
  it("builds a timeline the phone can draw: messages, tools, approvals", () => {
    const projection = toV2ThreadProjection({ thread: thread() });
    const items = projection["visibleTurnItems"] as Array<{
      position: number;
      item: Record<string, unknown>;
    }>;
    expect(items.map((row) => row.item["type"])).toEqual([
      "user_message",
      "command_execution",
      "approval_request",
      "assistant_message",
    ]);
    expect(items.map((row) => row.position)).toEqual([0, 1, 2, 3]);
    expect(items[2]!.item).toMatchObject({
      requestId: "req-1",
      requestKind: "command",
      status: "waiting",
    });
    expect(items[3]!.item).toMatchObject({ text: "on it", streaming: true });
    expect(projection["runtimeRequests"]).toEqual([
      expect.objectContaining({ id: "req-1", kind: "command", status: "pending" }),
    ]);
    expect(projection["runs"]).toEqual([
      expect.objectContaining({
        id: TURN_ID,
        status: "waiting",
        userMessageId: "m-user",
        ordinal: 1,
      }),
    ]);
  });

  it("resolves requests and keeps titles non-empty", () => {
    const resolved = thread({
      title: "  ",
      activities: [
        ...thread().activities,
        activity("a3", "approval.resolved", { requestId: "req-1" }, T3, 3),
      ],
    });
    const projection = toV2ThreadProjection({ thread: resolved });
    expect((projection["thread"] as Record<string, unknown>)["title"]).toBe("New chat");
    expect(deriveRuntimeRequests(resolved.activities)[0]).toMatchObject({ status: "resolved" });
  });
});

describe("v2 commands", () => {
  const now = T3;
  const base = { commandId: "c1", threadId: THREAD_ID };

  it("maps sidebar actions to Work's commands", () => {
    expect(translateV2Command({ ...base, type: "thread.pin" }, { now })).toEqual({
      kind: "dispatch",
      commands: [{ type: "thread.meta.update", ...base, pinnedAt: now }],
    });
    expect(
      translateV2Command({ ...base, type: "thread.snooze", snoozedUntil: T3 }, { now }),
    ).toMatchObject({ kind: "dispatch", commands: [{ type: "thread.snooze", snoozedUntil: T3 }] });
    expect(
      translateV2Command({ ...base, type: "thread.visit", visitedAt: T2, opened: true }, { now }),
    ).toEqual({
      kind: "dispatch",
      commands: [{ type: "thread.visit", ...base, visitedAt: T2 }],
    });
    expect(
      translateV2Command({ ...base, type: "thread.pin.reorder", orderKey: "a" }, { now }),
    ).toEqual({
      kind: "noop",
    });
    expect(
      translateV2Command({ ...base, type: "thread.auto-settle.set", enabled: false }, { now }),
    ).toEqual({
      kind: "reject",
      message: V2_REFUSAL.autoSettle,
    });
  });

  it("answers an approval or a question by request kind", () => {
    const requests = deriveRuntimeRequests([
      ...thread().activities,
      activity(
        "q1",
        "user-input.requested",
        {
          requestId: "req-q",
          questions: [
            {
              id: "q",
              header: "Pick",
              question: "Which?",
              options: [{ label: "A", description: "a" }],
            },
          ],
        },
        T3,
        3,
      ),
    ]);
    expect(
      translateV2Command(
        { ...base, type: "runtime-request.respond", requestId: "req-1", decision: "acceptAlways" },
        { now, requests },
      ),
    ).toMatchObject({
      kind: "dispatch",
      commands: [
        { type: "thread.approval.respond", requestId: "req-1", decision: "acceptForSession" },
      ],
    });
    expect(
      translateV2Command(
        { ...base, type: "runtime-request.respond", requestId: "req-q", answers: { q: "A" } },
        { now, requests },
      ),
    ).toMatchObject({
      kind: "dispatch",
      commands: [{ type: "thread.user-input.respond", requestId: "req-q", answers: { q: "A" } }],
    });
    expect(
      translateV2Command(
        { ...base, type: "thread.user-input.dismiss", requestId: "req-q" },
        { now, requests },
      ),
    ).toMatchObject({
      kind: "dispatch",
      commands: [{ type: "thread.user-input.respond", answers: {} }],
    });
  });

  it("sends a message only when the agent is free, without attachments", () => {
    const message = {
      ...base,
      type: "message.dispatch",
      messageId: "m2",
      text: "hi",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    };
    expect(translateV2Command(message, { now, thread: shell() })).toMatchObject({
      kind: "dispatch",
      commands: [{ type: "thread.turn.start", message: { messageId: "m2", text: "hi" } }],
    });
    expect(
      translateV2Command(message, { now, thread: shell({ session: thread().session }) }),
    ).toEqual({ kind: "reject", message: V2_REFUSAL.busy });
    expect(
      translateV2Command(
        { ...message, attachments: [{ type: "image" }] },
        { now, thread: shell() },
      ),
    ).toEqual({ kind: "reject", message: V2_REFUSAL.attachments });
  });

  it("stops a run and the thread", () => {
    expect(
      translateV2Command({ ...base, type: "run.interrupt", runId: TURN_ID }, { now }),
    ).toMatchObject({
      kind: "dispatch",
      commands: [{ type: "thread.turn.interrupt", turnId: TURN_ID }],
    });
    expect(translateV2Command({ ...base, type: "thread.stop" }, { now })).toMatchObject({
      kind: "dispatch",
      commands: [{ type: "thread.session.stop" }],
    });
  });

  it("launches new chats only in the project root", () => {
    const launch = {
      commandId: "c9",
      projectId: "project-1",
      title: "From phone",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
      runtimeMode: "auto",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "hello", attachments: [] },
    };
    const plan = translateV2Launch(launch, { now, newId: () => "new-id" });
    expect(plan).toMatchObject({
      threadId: "new-id",
      create: {
        kind: "dispatch",
        commands: [{ type: "thread.create", runtimeMode: "full-access", worktreePath: null }],
      },
      message: { type: "thread.turn.start", message: { text: "hello" } },
    });
    expect(
      translateV2Launch(
        { ...launch, workspaceStrategy: { type: "worktree", baseRef: "main" } },
        { now, newId: () => "x" },
      ),
    ).toEqual({ kind: "reject", message: V2_REFUSAL.worktree });
  });
});
