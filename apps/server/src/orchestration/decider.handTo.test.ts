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
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-hand-to");
const PARENT_ID = ThreadId.make("thread-parent");
const OTHER_ID = ThreadId.make("thread-other");
const CHILD_ID = ThreadId.make("thread-child");

const agentOrigin = (threadId: ThreadId): OrchestrationCommandOrigin => ({
  kind: "agent",
  threadId,
});

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

const CLOSED_AT = "2026-10-08T12:00:00.000Z";

const agentsAccess = (
  threadId: ThreadId,
  agentsClosedAt: string | null,
  id = "cmd-agents-access",
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make(id),
  threadId,
  agentsClosedAt,
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

const C_ID = ThreadId.make("thread-c");
const D_ID = ThreadId.make("thread-d");

const handTo = (
  threadId: ThreadId,
  handlerThreadId: ThreadId | null,
  id = `cmd-hand-${threadId}-${handlerThreadId ?? "back"}`,
  note?: string,
): OrchestrationCommand => ({
  type: "thread.handler.set",
  commandId: CommandId.make(id),
  threadId,
  handler:
    handlerThreadId === null
      ? null
      : {
          threadId: handlerThreadId,
          kind: "chat",
          title: `Thread ${handlerThreadId}`,
          ...(note !== undefined ? { note } : {}),
        },
  createdAt: new Date().toISOString(),
});

const errorOf = async (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) =>
  Effect.runPromise(
    decideOrchestrationCommand({ command, readModel, origin }).pipe(
      Effect.match({
        onFailure: (error) => String((error as { detail?: string }).detail ?? error),
        onSuccess: () => "ok",
      }),
    ),
  );

async function seedFour(): Promise<OrchestrationReadModel> {
  let readModel = await seedChild();
  readModel = (await decideAndApply(readModel, threadCreate(C_ID))).readModel;
  readModel = (await decideAndApply(readModel, threadCreate(D_ID))).readModel;
  return readModel;
}

describe("decider: thread.handler.set (Hand to…, T63)", () => {
  it("hands a person's chat to another chat: handler set, driven by an agent", async () => {
    const { events, readModel } = await decideAndApply(
      await seedFour(),
      handTo(OTHER_ID, C_ID, "cmd-hand", "take it to launch"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "thread.handler-changed",
      "thread.control-changed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      threadId: OTHER_ID,
      handler: { threadId: C_ID, kind: "chat", note: "take it to launch" },
      previousHandler: null,
      reason: "handed",
    });
    expect(threadOf(readModel, OTHER_ID)).toMatchObject({
      controller: "agent",
      handler: { threadId: C_ID, kind: "chat", note: "take it to launch" },
    });
  });

  it("takes it back: handler cleared, back with the person", async () => {
    const handed = (await decideAndApply(await seedFour(), handTo(OTHER_ID, C_ID))).readModel;
    const { events, readModel } = await decideAndApply(handed, handTo(OTHER_ID, null));
    expect(events.map((event) => event.type)).toEqual([
      "thread.handler-changed",
      "thread.control-changed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      handler: null,
      previousHandler: { threadId: C_ID },
      reason: "taken-back",
    });
    expect(threadOf(readModel, OTHER_ID)).toMatchObject({ controller: "human", handler: null });
    // Idempotent.
    expect(await decide(readModel, handTo(OTHER_ID, null, "cmd-again"))).toEqual([]);
  });

  it("re-hands to someone else without touching control", async () => {
    const handed = (await decideAndApply(await seedFour(), handTo(OTHER_ID, C_ID))).readModel;
    const { events } = await decideAndApply(handed, handTo(OTHER_ID, D_ID));
    expect(events.map((event) => event.type)).toEqual(["thread.handler-changed"]);
    expect(events[0]?.payload).toMatchObject({
      handler: { threadId: D_ID },
      previousHandler: { threadId: C_ID },
    });
  });

  it("refuses the chat itself, a chat it started, a loop and a chain deeper than 3", async () => {
    const readModel = await seedFour();
    expect(await errorOf(readModel, handTo(OTHER_ID, OTHER_ID))).toMatch(/^handler_self:/);
    expect(await errorOf(readModel, handTo(PARENT_ID, CHILD_ID))).toMatch(/^handler_subordinate:/);
    expect(await errorOf(readModel, handTo(OTHER_ID, ThreadId.make("nope")))).toMatch(
      /^handler_missing:/,
    );
    // A → B, then B → A is a loop.
    const aToB = (await decideAndApply(readModel, handTo(OTHER_ID, C_ID))).readModel;
    expect(await errorOf(aToB, handTo(C_ID, OTHER_ID))).toMatch(/^handler_loop:/);
    // A → B → C is fine; one more level is not.
    const bToC = (await decideAndApply(aToB, handTo(C_ID, D_ID))).readModel;
    const cToP = (await decideAndApply(bToC, handTo(D_ID, PARENT_ID))).readModel;
    expect(threadOf(cToP, D_ID).handler?.threadId).toBe(PARENT_ID);
    expect(await errorOf(cToP, handTo(PARENT_ID, CHILD_ID, "cmd-deep"))).toMatch(
      /^handler_(too_deep|subordinate):/,
    );
  });

  it("refuses a fourth hop", async () => {
    let readModel = await seedFour();
    readModel = (await decideAndApply(readModel, handTo(OTHER_ID, C_ID))).readModel;
    readModel = (await decideAndApply(readModel, handTo(C_ID, D_ID))).readModel;
    readModel = (await decideAndApply(readModel, handTo(D_ID, PARENT_ID))).readModel;
    const extra = ThreadId.make("thread-e");
    readModel = (await decideAndApply(readModel, threadCreate(extra))).readModel;
    expect(await errorOf(readModel, handTo(PARENT_ID, extra))).toMatch(/^handler_too_deep:/);
  });

  it("only the person hands; the handler may only give it back", async () => {
    const readModel = await seedFour();
    expect(await errorOf(readModel, handTo(OTHER_ID, C_ID), agentOrigin(C_ID))).toMatch(
      /^handler_person_only:/,
    );
    const handed = (await decideAndApply(readModel, handTo(OTHER_ID, C_ID))).readModel;
    expect(await errorOf(handed, handTo(OTHER_ID, null), agentOrigin(D_ID))).toMatch(
      /^not_your_handled_chat:/,
    );
    const back = await decide(handed, handTo(OTHER_ID, null), agentOrigin(C_ID));
    expect(back[0]?.payload).toMatchObject({ handler: null, reason: "taken-back" });
    const gone = await decide(
      handed,
      { ...handTo(OTHER_ID, null), reason: "handler-gone" } as OrchestrationCommand,
      { kind: "system", component: "hand-to" },
    );
    expect(gone[0]?.payload).toMatchObject({ handler: null, reason: "handler-gone" });
    // The person hears it in Needs you; taking it back doesn't call them.
    const called = gone.find((event) => event.type === "thread.person-called");
    expect(called?.payload).toMatchObject({
      threadId: OTHER_ID,
      calledByThreadId: null,
      reason: expect.stringMatching(/was removed — the chat is yours again$/),
    });
    expect(new Set(gone.map((event) => event.eventId)).size).toBe(gone.length);
    expect(back.map((event) => event.type)).not.toContain("thread.person-called");
  });

  it("lets the handler into a chat kept closed to other agents", async () => {
    let readModel = (await decideAndApply(await seedFour(), handTo(OTHER_ID, C_ID))).readModel;
    readModel = (await decideAndApply(readModel, agentsAccess(OTHER_ID, CLOSED_AT))).readModel;
    const fromHandler = await decide(readModel, turnStart(OTHER_ID, "cmd-h"), agentOrigin(C_ID));
    expect(fromHandler.map((event) => event.type)).toContain("thread.turn-start-requested");
    expect(await errorOf(readModel, turnStart(OTHER_ID, "cmd-d"), agentOrigin(D_ID))).toMatch(
      /^agents_closed:/,
    );
  });

  it("the person writing in a handed chat leaves it with the handler", async () => {
    const readModel = (await decideAndApply(await seedFour(), handTo(OTHER_ID, C_ID))).readModel;
    const { events, readModel: after } = await decideAndApply(
      readModel,
      turnStart(OTHER_ID, "cmd-person"),
    );
    expect(events.map((event) => event.type)).not.toContain("thread.control-changed");
    expect(threadOf(after, OTHER_ID)).toMatchObject({
      controller: "agent",
      handler: { threadId: C_ID },
    });
  });
});

describe("decider: Hand to… a chat on another computer (T63-C)", () => {
  const REMOTE_ID = ThreadId.make("thread-on-uno-work");
  const UNO_WORK = { boxId: 2531, name: "uno-work" };
  const handRemote = (
    threadId: ThreadId,
    id = `cmd-hand-remote-${threadId}`,
  ): OrchestrationCommand => ({
    type: "thread.handler.set",
    commandId: CommandId.make(id),
    threadId,
    handler: { threadId: REMOTE_ID, kind: "chat", computer: UNO_WORK, title: "Coordinator" },
    createdAt: new Date().toISOString(),
  });

  it("hands a chat to a chat that isn't on this computer, naming its computer", async () => {
    const { events, readModel } = await decideAndApply(await seedFour(), handRemote(OTHER_ID));
    expect(events.map((event) => event.type)).toEqual([
      "thread.handler-changed",
      "thread.control-changed",
    ]);
    expect(threadOf(readModel, OTHER_ID)).toMatchObject({
      controller: "agent",
      handler: { threadId: REMOTE_ID, computer: UNO_WORK, title: "Coordinator" },
    });
  });

  it("lets the remote handler's messages into a chat closed to other agents", async () => {
    let readModel = (await decideAndApply(await seedFour(), handRemote(OTHER_ID))).readModel;
    readModel = (await decideAndApply(readModel, agentsAccess(OTHER_ID, CLOSED_AT))).readModel;
    const events = await decide(readModel, turnStart(OTHER_ID, "cmd-r"), agentOrigin(REMOTE_ID));
    expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
    expect(events.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
      sentByThreadId: REMOTE_ID,
    });
  });

  it("refuses to send away a chat that handles chats itself (no loop across computers)", async () => {
    const readModel = (await decideAndApply(await seedFour(), handTo(C_ID, OTHER_ID))).readModel;
    expect(await errorOf(readModel, handRemote(OTHER_ID))).toMatch(/^handler_remote_busy:/);
  });

  it("refuses a handler here that is itself handed to another computer", async () => {
    const readModel = (await decideAndApply(await seedFour(), handRemote(OTHER_ID))).readModel;
    expect(await errorOf(readModel, handTo(C_ID, OTHER_ID))).toMatch(/^handler_remote:/);
  });

  it("only the person hands across; the daemon gives it back", async () => {
    expect(await errorOf(await seedFour(), handRemote(OTHER_ID), agentOrigin(C_ID))).toMatch(
      /^handler_person_only:/,
    );
    const readModel = (await decideAndApply(await seedFour(), handRemote(OTHER_ID))).readModel;
    const { readModel: back } = await decideAndApply(
      readModel,
      {
        ...(handTo(OTHER_ID, null, "cmd-gone") as Extract<
          OrchestrationCommand,
          { type: "thread.handler.set" }
        >),
        reason: "handler-gone",
      },
      { kind: "system", component: "hand-to-remote" },
    );
    expect(threadOf(back, OTHER_ID)).toMatchObject({ controller: "human", handler: null });
  });
});
