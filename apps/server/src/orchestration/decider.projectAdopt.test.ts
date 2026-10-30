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

const now = "2026-10-30T10:00:00.000Z";
const home = ProjectId.make("project-home");
const site = ProjectId.make("project-site");
const threadId = ThreadId.make("thread-adopt");

const envelope = (sequence: number, aggregateId: ProjectId | ThreadId) => ({
  sequence,
  eventId: EventId.make(`evt-${sequence}`),
  aggregateId,
  occurredAt: now,
  commandId: CommandId.make(`cmd-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-${sequence}`),
  metadata: {},
});

const projectCreated = (sequence: number, projectId: ProjectId, workspaceRoot: string) =>
  ({
    ...envelope(sequence, projectId),
    aggregateKind: "project",
    type: "project.created",
    payload: {
      projectId,
      title: workspaceRoot,
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  }) as OrchestrationEvent;

async function seed(worktreePath: string | null): Promise<OrchestrationReadModel> {
  const events: ReadonlyArray<OrchestrationEvent> = [
    projectCreated(1, home, "/home/u"),
    projectCreated(2, site, "/home/u/site"),
    {
      ...envelope(3, threadId),
      aggregateKind: "thread",
      type: "thread.created",
      payload: {
        threadId,
        projectId: home,
        title: "Site",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath,
        createdAt: now,
        updatedAt: now,
      },
    } as OrchestrationEvent,
  ];
  let readModel = createEmptyReadModel(now);
  for (const event of events) {
    readModel = await Effect.runPromise(projectEvent(readModel, event));
  }
  return readModel;
}

const adopt = (readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.project.adopt",
      commandId: CommandId.make("cmd-adopt"),
      threadId,
      projectId: site,
    },
    readModel,
  });

const decidedPayload = async (readModel: OrchestrationReadModel) => {
  const result = await Effect.runPromise(adopt(readModel));
  const event = Array.isArray(result) ? result[0] : result;
  expect(event?.type).toBe("thread.meta-updated");
  return event?.payload as { projectId?: string; worktreePath?: string | null };
};

describe("decider: thread.project.adopt", () => {
  it("moves a home-folder chat to the project and leaves it working where it was", async () => {
    const payload = await decidedPayload(await seed(null));
    expect(payload.projectId).toBe(site);
    expect(payload.worktreePath).toBe("/home/u");
  });

  it("makes a chat's own folder the project's root", async () => {
    const payload = await decidedPayload(await seed("/home/u/site"));
    expect(payload.projectId).toBe(site);
    expect(payload.worktreePath).toBeNull();
  });

  it("refuses while the chat is working", async () => {
    const readModel = await seed(null);
    const running: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
              },
            }
          : thread,
      ),
    };
    await expect(Effect.runPromise(adopt(running))).rejects.toThrow(/still working/);
  });
});
