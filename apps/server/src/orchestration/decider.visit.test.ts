import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
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

const PROJECT_ID = ProjectId.make("project-visit");
const THREAD_ID = ThreadId.make("thread-visit");
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
        title: "Project Visit",
        workspaceRoot: "/tmp/project-visit",
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
        title: "Thread Visit",
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

const visit = (visitedAt: string, id = "cmd-visit"): OrchestrationCommand => ({
  type: "thread.visit",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  visitedAt,
});

describe("thread.visit / thread.mark-unread (server read state)", () => {
  it("records the watermark without touching updatedAt", async () => {
    const seeded = await seedThread();
    const before = seeded.threads[0]!;
    const at = new Date(Date.now() + 1_000).toISOString();
    const { events, readModel } = await decideAndApply(seeded, visit(at));
    expect(events.map((event) => event.type)).toEqual(["thread.visited"]);
    const after = readModel.threads[0]!;
    expect(after.lastVisitedAt).toBe(at);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("never moves the watermark backwards (late or duplicate visit is a no-op)", async () => {
    const seeded = await seedThread();
    const later = new Date(Date.now() + 2_000).toISOString();
    const earlier = new Date(Date.now() + 1_000).toISOString();
    const { readModel } = await decideAndApply(seeded, visit(later, "cmd-1"));
    expect(await decide(readModel, visit(earlier, "cmd-2"))).toEqual([]);
    expect(await decide(readModel, visit(later, "cmd-3"))).toEqual([]);
  });

  it("mark-unread clears the watermark; on an unread chat it is a no-op", async () => {
    const seeded = await seedThread();
    const markUnread: OrchestrationCommand = {
      type: "thread.mark-unread",
      commandId: CommandId.make("cmd-unread"),
      threadId: THREAD_ID,
    };
    expect(await decide(seeded, markUnread)).toEqual([]);
    const visited = await decideAndApply(seeded, visit(new Date().toISOString()));
    const { events, readModel } = await decideAndApply(visited.readModel, markUnread);
    expect(events.map((event) => event.type)).toEqual(["thread.marked-unread"]);
    expect(readModel.threads[0]!.lastVisitedAt).toBeNull();
  });

  it("Read (Work) clears Your turn and moves the watermark up; mark-unread clears both", async () => {
    const seeded = await seedThread();
    const at = new Date(Date.now() + 1_000).toISOString();
    const read: OrchestrationCommand = {
      type: "thread.read",
      commandId: CommandId.make("cmd-read"),
      threadId: THREAD_ID,
      readAt: at,
    };
    const { events, readModel } = await decideAndApply(seeded, read);
    expect(events.map((event) => event.type)).toEqual(["thread.read"]);
    const after = readModel.threads[0]!;
    expect(after.readAt).toBe(at);
    expect(after.lastVisitedAt).toBe(at);
    expect(after.readStateUpdatedAt).not.toBeNull();
    expect(after.updatedAt).toBe(seeded.threads[0]!.updatedAt);
    // Repeated Read: no event.
    expect(await decide(readModel, { ...read, commandId: CommandId.make("cmd-read-2") })).toEqual(
      [],
    );
    const unread = await decideAndApply(readModel, {
      type: "thread.mark-unread",
      commandId: CommandId.make("cmd-unread-2"),
      threadId: THREAD_ID,
    });
    expect(unread.events.map((event) => event.type)).toEqual(["thread.marked-unread"]);
    expect(unread.readModel.threads[0]!.readAt).toBeNull();
    expect(unread.readModel.threads[0]!.lastVisitedAt).toBeNull();
  });

  it("Read keeps a later visit", async () => {
    const seeded = await seedThread();
    const later = new Date(Date.now() + 5_000).toISOString();
    const visited = await decideAndApply(seeded, visit(later));
    const { readModel } = await decideAndApply(visited.readModel, {
      type: "thread.read",
      commandId: CommandId.make("cmd-read"),
      threadId: THREAD_ID,
      readAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(readModel.threads[0]!.lastVisitedAt).toBe(later);
  });
});
