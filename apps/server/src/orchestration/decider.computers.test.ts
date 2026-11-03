import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectComputer,
  type ThreadComputerWait,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.make("project-macbook");
const THREAD_ID = ThreadId.make("thread-macbook");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const SYSTEM: OrchestrationCommandOrigin = { kind: "system", component: "computers" };
const CREATED_AT = "2026-11-03T09:00:00.000Z";

const COMPUTER: ProjectComputer = {
  computerId: "computer-1",
  computerName: "Kate's MacBook",
  path: "/Users/kate/projects/alpha",
};
const WAIT: ThreadComputerWait = {
  computerId: "computer-1",
  computerName: "Kate's MacBook",
  since: "2026-11-03T10:00:00.000Z",
};

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

const run = async (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) => apply(readModel, await decide(readModel, command, origin));

const refused = (promise: Promise<unknown>, detail: string) =>
  expect(promise).rejects.toMatchObject({ detail: expect.stringContaining(detail) });

const projectCreate = (computer?: ProjectComputer | null): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("cmd-project-create"),
  projectId: PROJECT_ID,
  title: "alpha",
  workspaceRoot: "/tmp/alpha",
  ...(computer !== undefined ? { computer } : {}),
  createdAt: CREATED_AT,
});

const threadCreate: OrchestrationCommand = {
  type: "thread.create",
  commandId: CommandId.make("cmd-thread-create"),
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "On the MacBook",
  modelSelection: MODEL,
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  createdAt: CREATED_AT,
};

const computerSet = (computer: ProjectComputer | null): OrchestrationCommand => ({
  type: "project.computer.set",
  commandId: CommandId.make("cmd-computer-set"),
  projectId: PROJECT_ID,
  computer,
  createdAt: "2026-11-03T11:00:00.000Z",
});

const waitSet = (computerWait: ThreadComputerWait | null): OrchestrationCommand => ({
  type: "thread.computer-wait.set",
  commandId: CommandId.make("cmd-wait-set"),
  threadId: THREAD_ID,
  computerWait,
  createdAt: "2026-11-03T10:00:00.000Z",
});

async function seed(computer?: ProjectComputer): Promise<OrchestrationReadModel> {
  const empty = createEmptyReadModel(CREATED_AT);
  const withProject = await run(empty, projectCreate(computer), SYSTEM);
  return run(withProject, threadCreate);
}

const projectOf = (readModel: OrchestrationReadModel) =>
  readModel.projects.find((project) => project.id === PROJECT_ID)!;
const threadOf = (readModel: OrchestrationReadModel) =>
  readModel.threads.find((thread) => thread.id === THREAD_ID)!;

describe("computers lifecycle commands", () => {
  it("creates a project on a computer from the daemon only", async () => {
    const empty = createEmptyReadModel(CREATED_AT);
    const [event] = await decide(empty, projectCreate(COMPUTER), SYSTEM);
    expect(event?.type).toBe("project.created");
    expect(event?.payload).toMatchObject({ computer: COMPUTER });
    expect(projectOf(await apply(empty, [event!])).computer).toEqual(COMPUTER);

    await refused(decide(empty, projectCreate(COMPUTER)), "computer_daemon_only");
    await refused(
      decide(empty, projectCreate(COMPUTER), { kind: "agent", threadId: THREAD_ID }),
      "computer_daemon_only",
    );
    // A project of this computer stays as it was, from anyone.
    const [plain] = await decide(empty, projectCreate());
    expect(plain?.payload).not.toHaveProperty("computer");
    expect(projectOf(await apply(empty, [plain!])).computer).toBeUndefined();
    await expect(decide(empty, projectCreate(null))).resolves.toHaveLength(1);
  });

  it("sets and clears a project's computer, moving its updatedAt", async () => {
    let readModel = await seed();
    readModel = await run(readModel, computerSet(COMPUTER), SYSTEM);
    expect(projectOf(readModel)).toMatchObject({
      computer: COMPUTER,
      updatedAt: "2026-11-03T11:00:00.000Z",
    });
    readModel = await run(readModel, computerSet(null), SYSTEM);
    expect(projectOf(readModel).computer).toBeNull();
  });

  it("sets a wait without moving the chat's updatedAt", async () => {
    let readModel = await seed(COMPUTER);
    const before = threadOf(readModel).updatedAt;
    const [event] = await decide(readModel, waitSet(WAIT), SYSTEM);
    expect(event).toMatchObject({
      type: "thread.computer-wait-set",
      payload: { threadId: THREAD_ID, computerWait: WAIT, updatedAt: WAIT.since },
    });
    readModel = await apply(readModel, [event!]);
    expect(threadOf(readModel)).toMatchObject({ computerWait: WAIT, updatedAt: before });

    readModel = await run(readModel, waitSet(null), SYSTEM);
    expect(threadOf(readModel)).toMatchObject({ computerWait: null, updatedAt: before });
  });

  it("refuses both commands from anyone but the daemon", async () => {
    const readModel = await seed(COMPUTER);
    const others: ReadonlyArray<OrchestrationCommandOrigin | undefined> = [
      undefined,
      { kind: "agent", threadId: THREAD_ID },
      { kind: "manager", tokenId: "tok" },
      { kind: "assistant", assistantKey: "assistant-home" },
    ];
    for (const origin of others) {
      await refused(decide(readModel, computerSet(null), origin), "computer_daemon_only");
      await refused(decide(readModel, waitSet(WAIT), origin), "computer_daemon_only");
    }
  });

  it("refuses a missing or deleted project or chat", async () => {
    const empty = createEmptyReadModel(CREATED_AT);
    await refused(decide(empty, computerSet(COMPUTER), SYSTEM), "does not exist");
    await refused(decide(empty, waitSet(WAIT), SYSTEM), "does not exist");

    let readModel = await seed(COMPUTER);
    readModel = await run(readModel, {
      type: "thread.delete",
      commandId: CommandId.make("cmd-thread-delete"),
      threadId: THREAD_ID,
    });
    await refused(decide(readModel, waitSet(WAIT), SYSTEM), "is deleted");
    readModel = await run(readModel, {
      type: "project.delete",
      commandId: CommandId.make("cmd-project-delete"),
      projectId: PROJECT_ID,
    });
    await refused(decide(readModel, computerSet(null), SYSTEM), "is deleted");
  });
});
