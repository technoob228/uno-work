import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationSessionStatus,
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

const PROJECT_ID = ProjectId.make("project-settle");
const THREAD_ID = ThreadId.make("thread-settle");
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
        title: "Project Settle",
        workspaceRoot: "/tmp/project-settle",
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
        title: "Thread Settle",
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

const settleCommand = (id = "cmd-settle"): OrchestrationCommand => ({
  type: "thread.settle",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
});

const unsettleCommand = (id = "cmd-unsettle"): OrchestrationCommand => ({
  type: "thread.unsettle",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  reason: "user",
});

const activityCommand = (kind: string, requestId: string): OrchestrationCommand => ({
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

const sessionSetCommand = (
  status: OrchestrationSessionStatus,
  id: string,
): OrchestrationCommand => ({
  type: "thread.session.set",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  createdAt: new Date().toISOString(),
  session: {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  },
});

const turnStartCommand = (id: string): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  message: {
    messageId: MessageId.make(`msg-${id}`),
    role: "user",
    text: "keep going",
    attachments: [],
  },
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: new Date().toISOString(),
});

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

describe("decider thread settle", () => {
  it("settles a thread and projects the override", async () => {
    const { events, readModel } = await decideAndApply(await seedThread(), settleCommand());
    expect(events.map((event) => event.type)).toEqual(["thread.settled"]);
    expect(threadOf(readModel).settledOverride).toBe("settled");
    expect(threadOf(readModel).settledAt).toEqual(expect.any(String));
  });

  it("keeps the original settledAt when settling twice", async () => {
    const first = await decideAndApply(await seedThread(), settleCommand());
    const settledAt = threadOf(first.readModel).settledAt;
    const second = await decideAndApply(first.readModel, settleCommand("cmd-settle-again"));
    expect(second.events.map((event) => event.type)).toEqual(["thread.settled"]);
    expect(threadOf(second.readModel).settledAt).toBe(settledAt);
  });

  it("clears the pin and the snooze when settling", async () => {
    const seeded = await seedThread();
    const pinned = await decideAndApply(seeded, {
      type: "thread.meta.update",
      commandId: CommandId.make("cmd-pin"),
      threadId: THREAD_ID,
      pinnedAt: new Date().toISOString(),
    });
    const snoozed = await decideAndApply(pinned.readModel, {
      type: "thread.snooze",
      commandId: CommandId.make("cmd-snooze"),
      threadId: THREAD_ID,
      snoozedUntil: inHours(2),
    });
    const { events, readModel } = await decideAndApply(snoozed.readModel, settleCommand());
    expect(events.map((event) => event.type)).toEqual([
      "thread.settled",
      "thread.meta-updated",
      "thread.unsnoozed",
    ]);
    expect(threadOf(readModel).pinnedAt).toBeNull();
    expect(threadOf(readModel).snoozedUntil).toBeNull();
    expect(threadOf(readModel).settledOverride).toBe("settled");
  });

  it("rejects settling while an approval is open or the session is working", async () => {
    const pending = await decideAndApply(
      await seedThread(),
      activityCommand("approval.requested", "req-1"),
    );
    await expect(decide(pending.readModel, settleCommand())).rejects.toThrow("pending approval");

    const running = await decideAndApply(await seedThread(), sessionSetCommand("running", "c-run"));
    await expect(decide(running.readModel, settleCommand())).rejects.toThrow("is working");
  });

  it("rejects settling an archived thread", async () => {
    const archived = await decideAndApply(await seedThread(), {
      type: "thread.archive",
      commandId: CommandId.make("cmd-archive"),
      threadId: THREAD_ID,
    });
    await expect(decide(archived.readModel, settleCommand())).rejects.toThrow("archived");
  });

  it("un-settles on request into a keep-active override", async () => {
    const settled = await decideAndApply(await seedThread(), settleCommand());
    const { events, readModel } = await decideAndApply(settled.readModel, unsettleCommand());
    expect(events.map((event) => event.type)).toEqual(["thread.unsettled"]);
    expect(events[0]?.payload).toMatchObject({ reason: "user" });
    expect(threadOf(readModel).settledOverride).toBe("active");
    expect(threadOf(readModel).settledAt).toBeNull();
  });

  it("resets the override to neutral when a new turn is requested", async () => {
    const settled = await decideAndApply(await seedThread(), settleCommand());
    const { events, readModel } = await decideAndApply(settled.readModel, turnStartCommand("t1"));
    expect(events.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({ reason: "activity" });
    expect(threadOf(readModel).settledOverride).toBeNull();
  });

  it("wakes a settled thread when its session comes alive, not on idle writes", async () => {
    const settled = await decideAndApply(await seedThread(), settleCommand());
    const ready = await decide(settled.readModel, sessionSetCommand("ready", "c-ready"));
    expect(ready.map((event) => event.type)).toEqual(["thread.session-set"]);
    const starting = await decideAndApply(
      settled.readModel,
      sessionSetCommand("starting", "c-start"),
    );
    expect(starting.events.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.session-set",
    ]);
    expect(threadOf(starting.readModel).settledOverride).toBeNull();
  });

  it("wakes a settled thread when the agent asks for input, not for ordinary activity", async () => {
    const settled = await decideAndApply(await seedThread(), settleCommand());
    const ordinary = await decide(settled.readModel, activityCommand("tool.completed", "r-2"));
    expect(ordinary.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    const question = await decide(
      settled.readModel,
      activityCommand("user-input.requested", "r-3"),
    );
    expect(question.map((event) => event.type)).toEqual([
      "thread.unsettled",
      "thread.activity-appended",
    ]);
  });

  it("leaves threads without an override untouched on activity", async () => {
    const events = await decide(await seedThread(), turnStartCommand("t2"));
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
