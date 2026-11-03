import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SNOOZED_UNTIL_OPENED,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadComputerSource,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-imported");
const THREAD_ID = ThreadId.make("imported-thread");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const ORIGIN: OrchestrationCommandOrigin = { kind: "system", component: "my-computer-import" };

const SOURCE: ThreadComputerSource = {
  kind: "computer",
  computerId: "computer-1",
  computerName: "Kate's MacBook",
  tool: "claude",
  sessionId: "11111111-2222-4333-8444-555555555555",
  path: "/Users/kate/.claude/projects/-a/11111111-2222-4333-8444-555555555555.jsonl",
  cwd: "/Users/kate/projects/alpha",
  lastActiveAt: "2026-10-20T10:00:00.000Z",
};

const STARTED_AT = "2026-10-01T10:00:00.000Z";

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

const decide = async (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) =>
  asArray(
    await Effect.runPromise(
      decideOrchestrationCommand({ command, readModel, ...(origin ? { origin } : {}) }),
    ),
  );

const seedProject = () => {
  const now = new Date().toISOString();
  return apply(createEmptyReadModel(now), [
    {
      occurredAt: now,
      causationEventId: null,
      metadata: {},
      eventId: EventId.make("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      commandId: CommandId.make("cmd-project-create"),
      correlationId: CommandId.make("cmd-project-create"),
      payload: {
        projectId: PROJECT_ID,
        title: "alpha",
        workspaceRoot: "/tmp/alpha",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    } as PlannedEvent,
  ]);
};

const createCommand: OrchestrationCommand = {
  type: "thread.create",
  commandId: CommandId.make("cmd-create"),
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Fix the login page",
  modelSelection: MODEL,
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  source: SOURCE,
  createdAt: STARTED_AT,
};

async function seedImported(): Promise<OrchestrationReadModel> {
  const readModel = await seedProject();
  return apply(readModel, await decide(readModel, createCommand, ORIGIN));
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

const refused = (run: Promise<unknown>) =>
  expect(run).rejects.toMatchObject({ detail: expect.stringContaining("imported_chat") });

describe("imported chats", () => {
  it("keeps the computer's dates on the chat and today's on the event", async () => {
    const readModel = await seedProject();
    const [event] = await decide(readModel, createCommand, ORIGIN);
    expect(event?.type).toBe("thread.created");
    expect(event?.payload).toMatchObject({
      source: SOURCE,
      createdAt: STARTED_AT,
      updatedAt: SOURCE.lastActiveAt,
    });
    expect(Date.parse(event!.occurredAt)).toBeGreaterThan(Date.parse(STARTED_AT));

    const thread = threadOf(await apply(readModel, [event!]));
    expect(thread.source).toEqual(SOURCE);
    expect(thread.updatedAt).toBe(SOURCE.lastActiveAt);
  });

  it("can't be faked by a client", async () => {
    await refused(decide(await seedProject(), createCommand));
    const readModel = await seedImported();
    const update: OrchestrationCommand = {
      type: "thread.source.update",
      commandId: CommandId.make("cmd-update"),
      threadId: THREAD_ID,
      source: SOURCE,
    };
    await refused(decide(readModel, update));
  });

  it("follows the computer on an update, keeping the title unless given", async () => {
    const readModel = await seedImported();
    const later = { ...SOURCE, lastActiveAt: "2026-10-30T10:00:00.000Z" };
    const update: OrchestrationCommand = {
      type: "thread.source.update",
      commandId: CommandId.make("cmd-update"),
      threadId: THREAD_ID,
      source: later,
    };
    const updated = threadOf(await apply(readModel, await decide(readModel, update, ORIGIN)));
    expect(updated.source).toEqual(later);
    expect(updated.updatedAt).toBe(later.lastActiveAt);
    expect(updated.title).toBe("Fix the login page");

    const renamed = threadOf(
      await apply(readModel, await decide(readModel, { ...update, title: "New" }, ORIGIN)),
    );
    expect(renamed.title).toBe("New");
  });

  it("stays at its own time through Snoozed and back", async () => {
    let readModel = await seedImported();
    readModel = await apply(
      readModel,
      await decide(
        readModel,
        {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze"),
          threadId: THREAD_ID,
          snoozedUntil: SNOOZED_UNTIL_OPENED,
        },
        ORIGIN,
      ),
    );
    expect(threadOf(readModel)).toMatchObject({
      snoozedUntil: SNOOZED_UNTIL_OPENED,
      updatedAt: SOURCE.lastActiveAt,
    });
    readModel = await apply(
      readModel,
      await decide(readModel, {
        type: "thread.unsnooze",
        commandId: CommandId.make("cmd-unsnooze"),
        threadId: THREAD_ID,
        reason: "user",
      }),
    );
    expect(threadOf(readModel)).toMatchObject({
      snoozedUntil: null,
      updatedAt: SOURCE.lastActiveAt,
    });
  });

  it("continues: a person's message starts a turn, the handoff seed is appended", async () => {
    const readModel = await seedImported();
    const message = {
      messageId: MessageId.make("message-1"),
      role: "user" as const,
      text: "Carry on",
      attachments: [],
    };
    const turn = await decide(readModel, {
      type: "thread.turn.start",
      commandId: CommandId.make("cmd-turn"),
      threadId: THREAD_ID,
      message,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: new Date().toISOString(),
    });
    expect(turn.map((event) => event.type)).toEqual(
      expect.arrayContaining(["thread.message-sent", "thread.turn-start-requested"]),
    );
    const seed = await decide(
      readModel,
      {
        type: "thread.message.user.append",
        commandId: CommandId.make("cmd-append"),
        threadId: THREAD_ID,
        messageId: MessageId.make("message-seed"),
        text: "Earlier on the computer: ...",
        createdAt: new Date().toISOString(),
      },
      ORIGIN,
    );
    expect(seed.map((event) => event.type)).toEqual(["thread.message-sent"]);
    // Still the imported chat: the source stays on it.
    expect(threadOf(await apply(readModel, turn)).source).toEqual(SOURCE);
  });
});
