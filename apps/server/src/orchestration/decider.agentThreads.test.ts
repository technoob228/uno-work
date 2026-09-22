import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadController,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-agent-threads");
const PARENT_ID = ThreadId.make("thread-parent");
const OTHER_ID = ThreadId.make("thread-other");
const CHILD_ID = ThreadId.make("thread-child");

const agentOrigin = (threadId: ThreadId): OrchestrationCommandOrigin => ({
  kind: "agent",
  threadId,
});

const CONNECTOR_ORIGIN: OrchestrationCommandOrigin = { kind: "connector", connector: "telegram" };

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

async function decide(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) {
  return asArray(
    await Effect.runPromise(decideOrchestrationCommand({ command, readModel, origin })),
  );
}

async function decideAndApply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) {
  const events = await decide(readModel, command, origin);
  return { events, readModel: await apply(readModel, events) };
}

const threadCreate = (
  threadId: ThreadId,
  spawnedByThreadId?: ThreadId,
): Extract<OrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`cmd-create-${threadId}`),
  threadId,
  projectId: PROJECT_ID,
  title: `Thread ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  ...(spawnedByThreadId !== undefined ? { spawnedByThreadId } : {}),
  createdAt: new Date().toISOString(),
});

const turnStart = (threadId: ThreadId, id = "cmd-turn"): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(id),
  threadId,
  message: {
    messageId: MessageId.make(`msg-${id}`),
    role: "user",
    text: "do the thing",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: new Date().toISOString(),
});

const controlSet = (
  threadId: ThreadId,
  controller: ThreadController,
  id = "cmd-control",
): OrchestrationCommand => ({
  type: "thread.control.set",
  commandId: CommandId.make(id),
  threadId,
  controller,
  createdAt: new Date().toISOString(),
});

async function seedParents(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  let readModel = await apply(createEmptyReadModel(now), [
    {
      eventId: EventId.make("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Agent threads",
        workspaceRoot: "/tmp/agent-threads",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
  readModel = (await decideAndApply(readModel, threadCreate(PARENT_ID))).readModel;
  readModel = (await decideAndApply(readModel, threadCreate(OTHER_ID))).readModel;
  return readModel;
}

async function seedChild(): Promise<OrchestrationReadModel> {
  return (
    await decideAndApply(
      await seedParents(),
      threadCreate(CHILD_ID, PARENT_ID),
      agentOrigin(PARENT_ID),
    )
  ).readModel;
}

const threadOf = (readModel: OrchestrationReadModel, threadId: ThreadId) =>
  readModel.threads.find((thread) => thread.id === threadId)!;

describe("decider agent-spawned threads: thread.create", () => {
  it("creates a human-controlled thread without spawnedByThreadId", async () => {
    const readModel = await seedParents();
    expect(threadOf(readModel, PARENT_ID)).toMatchObject({
      spawnedByThreadId: null,
      controller: "human",
      controlChangedAt: null,
    });
  });

  it("creates an agent-controlled child when the parent's agent dispatches it", async () => {
    const { events, readModel } = await decideAndApply(
      await seedParents(),
      threadCreate(CHILD_ID, PARENT_ID),
      agentOrigin(PARENT_ID),
    );
    expect(events.map((event) => event.type)).toEqual(["thread.created"]);
    expect(events[0]?.payload).toMatchObject({ spawnedByThreadId: PARENT_ID });
    expect(threadOf(readModel, CHILD_ID)).toMatchObject({
      spawnedByThreadId: PARENT_ID,
      controller: "agent",
      controlChangedAt: null,
    });
  });

  it("rejects spawnedByThreadId without an agent origin", async () => {
    const readModel = await seedParents();
    await expect(decide(readModel, threadCreate(CHILD_ID, PARENT_ID))).rejects.toThrow(
      "spawn_origin_mismatch:",
    );
    await expect(
      decide(readModel, threadCreate(CHILD_ID, PARENT_ID), CONNECTOR_ORIGIN),
    ).rejects.toThrow("spawn_origin_mismatch:");
  });

  it("rejects spawnedByThreadId that differs from the agent origin", async () => {
    await expect(
      decide(await seedParents(), threadCreate(CHILD_ID, PARENT_ID), agentOrigin(OTHER_ID)),
    ).rejects.toThrow("spawn_origin_mismatch:");
  });

  it("rejects a parent thread that does not exist", async () => {
    const ghost = ThreadId.make("thread-ghost");
    await expect(
      decide(await seedParents(), threadCreate(CHILD_ID, ghost), agentOrigin(ghost)),
    ).rejects.toThrow("parent_thread_not_found:");
  });
});

describe("decider agent-spawned threads: thread.turn.start", () => {
  it("lets the parent agent send into its agent-controlled child", async () => {
    const { events, readModel } = await decideAndApply(
      await seedChild(),
      turnStart(CHILD_ID),
      agentOrigin(PARENT_ID),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({ sentByThreadId: PARENT_ID });
    const child = threadOf(readModel, CHILD_ID);
    expect(child.controller).toBe("agent");
    expect(child.messages.at(-1)?.sentByThreadId).toBe(PARENT_ID);
  });

  it("lets any agent message a peer thread without touching control", async () => {
    // A non-parent agent into someone else's agent-driven child.
    const peer = await decideAndApply(
      await seedChild(),
      turnStart(CHILD_ID),
      agentOrigin(OTHER_ID),
    );
    expect(peer.events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(peer.events[0]?.payload).toMatchObject({ sentByThreadId: OTHER_ID });
    expect(threadOf(peer.readModel, CHILD_ID).controller).toBe("agent");

    // A child answering its parent, a human-created thread.
    const reply = await decideAndApply(peer.readModel, turnStart(PARENT_ID), agentOrigin(CHILD_ID));
    expect(reply.events[0]?.payload).toMatchObject({ sentByThreadId: CHILD_ID });
    expect(threadOf(reply.readModel, PARENT_ID)).toMatchObject({
      controller: "human",
      controlChangedAt: null,
    });
  });

  it("rejects an agent messaging its own thread", async () => {
    await expect(
      decide(await seedChild(), turnStart(PARENT_ID), agentOrigin(PARENT_ID)),
    ).rejects.toThrow("cannot_message_self:");
  });

  it("rejects every agent once a human holds control of an agent thread", async () => {
    const handedOff = await decideAndApply(await seedChild(), controlSet(CHILD_ID, "human"));
    await expect(
      decide(handedOff.readModel, turnStart(CHILD_ID), agentOrigin(PARENT_ID)),
    ).rejects.toThrow("human_in_control:");
    await expect(
      decide(handedOff.readModel, turnStart(CHILD_ID), agentOrigin(OTHER_ID)),
    ).rejects.toThrow("human_in_control:");
  });

  it("takes control for a human writing from the UI, before the message", async () => {
    const { events, readModel } = await decideAndApply(await seedChild(), turnStart(CHILD_ID));
    expect(events.map((event) => event.type)).toEqual([
      "thread.control-changed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({ controller: "human", reason: "human-message" });
    expect(events[1]?.payload).not.toHaveProperty("sentByThreadId");
    expect(events[2]?.causationEventId).toBe(events[1]?.eventId);
    const child = threadOf(readModel, CHILD_ID);
    expect(child.controller).toBe("human");
    expect(child.controlChangedAt).toEqual(expect.any(String));
  });

  it("takes control for a human writing through a connector", async () => {
    const events = await decide(await seedChild(), turnStart(CHILD_ID), CONNECTOR_ORIGIN);
    expect(events[0]?.type).toBe("thread.control-changed");
  });

  it("does not touch control for manager or system origins", async () => {
    const readModel = await seedChild();
    const origins: ReadonlyArray<OrchestrationCommandOrigin> = [
      { kind: "manager", tokenId: "token-1" },
      { kind: "system", component: "test" },
    ];
    for (const origin of origins) {
      const events = await decide(readModel, turnStart(CHILD_ID), origin);
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }
  });

  it("does not emit control events for a human writing into a human thread", async () => {
    const events = await decide(await seedChild(), turnStart(PARENT_ID));
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});

describe("decider agent-spawned threads: thread.control.set", () => {
  it("rejects a thread that was not spawned by an agent", async () => {
    await expect(decide(await seedChild(), controlSet(PARENT_ID, "agent"))).rejects.toThrow(
      "not_agent_thread:",
    );
  });

  it("hands control between the human and the agent", async () => {
    const toHuman = await decideAndApply(await seedChild(), controlSet(CHILD_ID, "human"));
    expect(toHuman.events.map((event) => event.type)).toEqual(["thread.control-changed"]);
    expect(toHuman.events[0]?.payload).toMatchObject({ controller: "human", reason: "handoff" });
    expect(threadOf(toHuman.readModel, CHILD_ID).controller).toBe("human");

    const toAgent = await decideAndApply(
      toHuman.readModel,
      controlSet(CHILD_ID, "agent", "cmd-control-back"),
    );
    expect(toAgent.events[0]?.payload).toMatchObject({ controller: "agent", reason: "handoff" });
    expect(threadOf(toAgent.readModel, CHILD_ID).controller).toBe("agent");
  });

  it("is a no-op when the controller is already set", async () => {
    expect(await decide(await seedChild(), controlSet(CHILD_ID, "agent"))).toEqual([]);
  });

  it("lets the parent agent release control to the human", async () => {
    const { events, readModel } = await decideAndApply(
      await seedChild(),
      controlSet(CHILD_ID, "human"),
      agentOrigin(PARENT_ID),
    );
    expect(events.map((event) => event.type)).toEqual(["thread.control-changed"]);
    expect(threadOf(readModel, CHILD_ID).controller).toBe("human");
  });

  it("rejects an agent taking control back", async () => {
    const handedOff = await decideAndApply(await seedChild(), controlSet(CHILD_ID, "human"));
    await expect(
      decide(
        handedOff.readModel,
        controlSet(CHILD_ID, "agent", "cmd-grab"),
        agentOrigin(PARENT_ID),
      ),
    ).rejects.toThrow("agent_cannot_take_control:");
  });

  it("rejects a non-parent agent releasing control", async () => {
    await expect(
      decide(await seedChild(), controlSet(CHILD_ID, "human"), agentOrigin(OTHER_ID)),
    ).rejects.toThrow("not_your_thread:");
  });
});
