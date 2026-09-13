import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-snooze");
const THREAD_ID = ThreadId.make("thread-snooze");
const HOUR_MS = 60 * 60 * 1_000;

const inHours = (hours: number) => new Date(Date.now() + hours * HOUR_MS).toISOString();

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const asArray = (decided: PlannedEvent | ReadonlyArray<PlannedEvent>) =>
  Array.isArray(decided) ? decided : [decided as PlannedEvent];

async function apply(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<PlannedEvent>,
): Promise<OrchestrationReadModel> {
  let next = readModel;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 } as OrchestrationEvent),
    );
  }
  return next;
}

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  return asArray(await Effect.runPromise(decideOrchestrationCommand({ command, readModel })));
}

async function decideAndApply(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const events = await decide(readModel, command);
  return { events, readModel: await apply(readModel, events) };
}

async function seedThread(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  const base = {
    occurredAt: now,
    causationEventId: null,
    metadata: {},
  } as const;
  return apply(createEmptyReadModel(now), [
    {
      ...base,
      eventId: EventId.make("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      commandId: CommandId.make("cmd-project-create"),
      correlationId: CommandId.make("cmd-project-create"),
      payload: {
        projectId: PROJECT_ID,
        title: "Project Snooze",
        workspaceRoot: "/tmp/project-snooze",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...base,
      eventId: EventId.make("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      commandId: CommandId.make("cmd-thread-create"),
      correlationId: CommandId.make("cmd-thread-create"),
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread Snooze",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
}

const snoozeCommand = (snoozedUntil: string, id = "cmd-snooze"): OrchestrationCommand => ({
  type: "thread.snooze",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  snoozedUntil,
});

const approvalActivityCommand = (kind: string, requestId: string): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.make(`cmd-${kind}-${requestId}`),
  threadId: THREAD_ID,
  createdAt: new Date().toISOString(),
  activity: {
    id: EventId.make(`evt-${kind}-${requestId}`),
    tone: "approval",
    kind,
    summary: "Approval requested",
    payload: { requestId },
    turnId: null,
    createdAt: new Date().toISOString(),
  },
});

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

describe("decider thread snooze", () => {
  it("snoozes a thread and projects the wake time", async () => {
    const wake = inHours(1);
    const { events, readModel } = await decideAndApply(await seedThread(), snoozeCommand(wake));
    expect(events.map((event) => event.type)).toEqual(["thread.snoozed"]);
    expect(threadOf(readModel).snoozedUntil).toBe(wake);
    expect(threadOf(readModel).snoozedAt).toEqual(expect.any(String));
  });

  it("keeps the original snoozedAt when the same wake time is sent twice", async () => {
    const wake = inHours(2);
    const first = await decideAndApply(await seedThread(), snoozeCommand(wake));
    const snoozedAt = threadOf(first.readModel).snoozedAt;
    const second = await decideAndApply(first.readModel, snoozeCommand(wake, "cmd-snooze-again"));
    expect(threadOf(second.readModel).snoozedAt).toBe(snoozedAt);
  });

  it("rejects a wake time that is not in the future", async () => {
    const readModel = await seedThread();
    await expect(decide(readModel, snoozeCommand(inHours(-1)))).rejects.toThrow(
      "is not in the future",
    );
    await expect(decide(readModel, snoozeCommand("not-a-date"))).rejects.toThrow(
      "is not in the future",
    );
  });

  it("rejects snoozing while an approval is open", async () => {
    const pending = await decideAndApply(
      await seedThread(),
      approvalActivityCommand("approval.requested", "req-1"),
    );
    await expect(decide(pending.readModel, snoozeCommand(inHours(1)))).rejects.toThrow(
      "pending approval",
    );
    const resolved = await decideAndApply(
      pending.readModel,
      approvalActivityCommand("approval.resolved", "req-1"),
    );
    const snoozed = await decide(resolved.readModel, snoozeCommand(inHours(1)));
    expect(snoozed.map((event) => event.type)).toEqual(["thread.snoozed"]);
  });

  it("rejects snoozing an archived thread", async () => {
    const archived = await decideAndApply(await seedThread(), {
      type: "thread.archive",
      commandId: CommandId.make("cmd-archive"),
      threadId: THREAD_ID,
    });
    await expect(decide(archived.readModel, snoozeCommand(inHours(1)))).rejects.toThrow("archived");
  });

  it("unsnoozes on request and treats unsnoozing an awake thread as a no-op", async () => {
    const snoozed = await decideAndApply(await seedThread(), snoozeCommand(inHours(1)));
    const unsnoozeCommand: OrchestrationCommand = {
      type: "thread.unsnooze",
      commandId: CommandId.make("cmd-unsnooze"),
      threadId: THREAD_ID,
      reason: "user",
    };
    const woke = await decideAndApply(snoozed.readModel, unsnoozeCommand);
    expect(woke.events.map((event) => event.type)).toEqual(["thread.unsnoozed"]);
    expect(threadOf(woke.readModel).snoozedUntil).toBeNull();
    expect(threadOf(woke.readModel).snoozedAt).toBeNull();
    expect(await decide(woke.readModel, unsnoozeCommand)).toEqual([]);
  });

  it("wakes a snoozed thread when the agent asks for approval", async () => {
    const snoozed = await decideAndApply(await seedThread(), snoozeCommand(inHours(3)));
    const { events, readModel } = await decideAndApply(
      snoozed.readModel,
      approvalActivityCommand("approval.requested", "req-2"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.unsnoozed",
      "thread.activity-appended",
    ]);
    expect(events[0]?.payload).toMatchObject({ reason: "activity" });
    expect(threadOf(readModel).snoozedUntil).toBeNull();
  });

  it("wakes a snoozed thread when the agent asks a question", async () => {
    const snoozed = await decideAndApply(await seedThread(), snoozeCommand(inHours(3)));
    const events = await decide(
      snoozed.readModel,
      approvalActivityCommand("user-input.requested", "req-3"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.unsnoozed",
      "thread.activity-appended",
    ]);
  });

  it("does not touch the snooze for ordinary activity", async () => {
    const snoozed = await decideAndApply(await seedThread(), snoozeCommand(inHours(3)));
    const events = await decide(
      snoozed.readModel,
      approvalActivityCommand("tool.completed", "req-4"),
    );
    expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
  });

  it("wakes a snoozed thread when a new turn is requested", async () => {
    const snoozed = await decideAndApply(await seedThread(), snoozeCommand(inHours(3)));
    const { events, readModel } = await decideAndApply(snoozed.readModel, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make("msg-1"),
        role: "user",
        text: "keep going",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: new Date().toISOString(),
    });
    expect(events.map((event) => event.type)).toEqual([
      "thread.unsnoozed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(threadOf(readModel).snoozedUntil).toBeNull();
  });

  it("rejects snoozing right after a message nobody picked up yet", async () => {
    const readModel = await seedThread();
    const sent = await decideAndApply(readModel, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn-start-queued"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.make("msg-queued"),
        role: "user",
        text: "do the thing",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: new Date().toISOString(),
    });
    await expect(decide(sent.readModel, snoozeCommand(inHours(1)))).rejects.toThrow(
      "queued turn start",
    );
  });
});
