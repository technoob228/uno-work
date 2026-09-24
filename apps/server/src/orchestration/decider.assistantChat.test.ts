import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadAssistantRole,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("assistant-home");
const LEGACY_ID = ThreadId.make("thread-legacy-assistant-chat");
const OTHER_ID = ThreadId.make("thread-other");
const SPAWNED_ID = ThreadId.make("thread-spawned");

const SYSTEM: OrchestrationCommandOrigin = { kind: "assistant", assistantKey: "assistant-home" };
const MANAGER: OrchestrationCommandOrigin = { kind: "manager", tokenId: "tok-1" };

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

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

async function decideExit(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) {
  return Effect.runPromiseExit(decideOrchestrationCommand({ command, readModel, origin }));
}

async function decideAndApply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel, origin }),
  );
  const events = Array.isArray(decided) ? decided : [decided as PlannedEvent];
  return apply(readModel, events);
}

const threadCreate = (
  threadId: ThreadId,
  assistantRole?: ThreadAssistantRole,
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
  ...(assistantRole !== undefined ? { assistantRole } : {}),
  createdAt: new Date().toISOString(),
});

const markChat = (threadId: ThreadId): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make(`cmd-mark-${threadId}`),
  threadId,
  assistantRole: "chat",
});

async function seed(): Promise<OrchestrationReadModel> {
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
        title: "Assistant",
        workspaceRoot: "/tmp/assistant-home",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
  readModel = await decideAndApply(readModel, threadCreate(LEGACY_ID));
  readModel = await decideAndApply(readModel, threadCreate(OTHER_ID));
  return readModel;
}

const threadOf = (readModel: OrchestrationReadModel, threadId: ThreadId) =>
  readModel.threads.find((thread) => thread.id === threadId)!;

describe("decider: assistant chat role", () => {
  it("regular chats have no assistant role", async () => {
    expect(threadOf(await seed(), LEGACY_ID).assistantRole).toBeNull();
  });

  it("the migration marks an existing chat as THE assistant chat and keeps its history", async () => {
    const before = await seed();
    const after = await decideAndApply(before, markChat(LEGACY_ID), SYSTEM);
    const thread = threadOf(after, LEGACY_ID);
    expect(thread.assistantRole).toBe("chat");
    // Nothing else about the chat changes: same project, title, messages.
    const previous = threadOf(before, LEGACY_ID);
    expect(thread.projectId).toBe(previous.projectId);
    expect(thread.title).toBe(previous.title);
    expect(thread.messages).toEqual(previous.messages);
  });

  it("refuses a second assistant chat", async () => {
    const readModel = await decideAndApply(await seed(), markChat(LEGACY_ID), SYSTEM);
    const exit = await decideExit(readModel, markChat(OTHER_ID), SYSTEM);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("assistant_chat_exists");
    // Re-marking the same chat is fine (idempotent migration).
    const again = await decideExit(readModel, markChat(LEGACY_ID), SYSTEM);
    expect(Exit.isSuccess(again)).toBe(true);
  });

  it("a person's command cannot change the assistant role", async () => {
    const exit = await decideExit(await seed(), markChat(OTHER_ID));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("assistant_role_forbidden");
    const created = await decideExit(await seed(), threadCreate(SPAWNED_ID, "spawned"));
    expect(Exit.isFailure(created)).toBe(true);
  });

  it("chats the assistant starts are created as spawned", async () => {
    const readModel = await decideAndApply(
      await seed(),
      threadCreate(SPAWNED_ID, "spawned"),
      MANAGER,
    );
    expect(threadOf(readModel, SPAWNED_ID).assistantRole).toBe("spawned");
  });

  it("the manager cannot make a chat THE assistant chat", async () => {
    const exit = await decideExit(await seed(), markChat(OTHER_ID), MANAGER);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
