import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const PROJECT_ID = asProjectId("project-archive");
const THREAD_ID = asThreadId("thread-archive");

async function seedActiveThread(): Promise<OrchestrationReadModel> {
  const now = new Date().toISOString();
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: now,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );

  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: now,
      commandId: asCommandId("cmd-thread-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread Archive",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function seedArchivedThread(): Promise<OrchestrationReadModel> {
  const active = await seedActiveThread();
  const now = new Date().toISOString();
  return Effect.runPromise(
    projectEvent(active, {
      sequence: 3,
      eventId: asEventId("evt-thread-archive"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.archived",
      occurredAt: now,
      commandId: asCommandId("cmd-thread-archive-seed"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-archive-seed"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        archivedAt: now,
        updatedAt: now,
      },
    }),
  );
}

const asArray = (
  decided:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) => (Array.isArray(decided) ? decided : [decided]);

describe("decider archive idempotency", () => {
  it("archives an active thread", async () => {
    const readModel = await seedActiveThread();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive"),
          threadId: THREAD_ID,
        },
        readModel,
      }),
    );
    expect(asArray(decided).map((event) => event.type)).toEqual(["thread.archived"]);
  });

  it("treats archiving an already-archived thread as a no-op", async () => {
    const readModel = await seedArchivedThread();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-again"),
          threadId: THREAD_ID,
        },
        readModel,
      }),
    );
    // No event emitted — the command succeeds instead of raising an invariant
    // failure the user would see as an error toast.
    expect(asArray(decided)).toEqual([]);
  });

  it("still rejects archiving a thread that does not exist", async () => {
    const readModel = await seedActiveThread();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: asCommandId("cmd-archive-missing"),
            threadId: asThreadId("thread-missing"),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("unarchives an archived thread", async () => {
    const readModel = await seedArchivedThread();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-unarchive"),
          threadId: THREAD_ID,
        },
        readModel,
      }),
    );
    expect(asArray(decided).map((event) => event.type)).toEqual(["thread.unarchived"]);
  });

  it("treats unarchiving a non-archived thread as a no-op", async () => {
    const readModel = await seedActiveThread();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: asCommandId("cmd-unarchive-noop"),
          threadId: THREAD_ID,
        },
        readModel,
      }),
    );
    expect(asArray(decided)).toEqual([]);
  });
});
