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
  type ThreadPullRequest,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-pr");
const THREAD_ID = ThreadId.make("thread-pr");

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

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<PlannedEvent>;
  return { events, readModel: await apply(readModel, events) };
}

async function seedThread(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  const base = { occurredAt: now, causationEventId: null, metadata: {} } as const;
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
        title: "Project",
        workspaceRoot: "/tmp/project-pr",
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
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "fix/login",
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
}

const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

const link: ThreadPullRequest = {
  provider: "github",
  repository: "getuno/app",
  number: 12 as ThreadPullRequest["number"],
  url: "https://github.com/getuno/app/pull/12",
  source: "branch",
  linkedAt: "2026-10-30T10:00:00.000Z",
  snapshot: null,
};

const autoSettle = (disabled: boolean, id: string): OrchestrationCommand => ({
  type: "thread.auto-settle.set",
  commandId: CommandId.make(id),
  threadId: THREAD_ID,
  disabled,
});

describe("decider thread pull requests", () => {
  it("stores the links without counting as activity in the chat", async () => {
    const seeded = await seedThread();
    const before = threadOf(seeded).updatedAt;
    const { events, readModel } = await decide(seeded, {
      type: "thread.pull-requests.sync",
      commandId: CommandId.make("cmd-sync"),
      threadId: THREAD_ID,
      pullRequests: [link],
      createdAt: "2026-10-30T10:00:00.000Z",
    });
    expect(events.map((event) => event.type)).toEqual(["thread.pull-requests-updated"]);
    expect(threadOf(readModel).pullRequests).toEqual([link]);
    expect(threadOf(readModel).updatedAt).toBe(before);
  });

  it("turns auto-settle off and on for one chat, and ignores a repeat", async () => {
    const off = await decide(await seedThread(), autoSettle(true, "cmd-off"));
    expect(off.events.map((event) => event.type)).toEqual(["thread.auto-settle-updated"]);
    expect(threadOf(off.readModel).autoSettleDisabledAt).toEqual(expect.any(String));

    const repeat = await decide(off.readModel, autoSettle(true, "cmd-off-again"));
    expect(repeat.events).toEqual([]);

    const on = await decide(off.readModel, autoSettle(false, "cmd-on"));
    expect(threadOf(on.readModel).autoSettleDisabledAt).toBeNull();
  });
});
