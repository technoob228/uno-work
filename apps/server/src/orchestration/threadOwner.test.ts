import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
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

const T0 = "2026-10-28T10:00:00.000Z";
const T1 = "2026-10-28T10:05:00.000Z";
const T2 = "2026-10-28T10:10:00.000Z";
const THREAD = ThreadId.make("thread-1");
const CALLER = ThreadId.make("thread-caller");
const UNO: OrchestrationCommandOrigin = { kind: "manager", tokenId: "token-uno" };

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

let sequence = 0;
function event(
  type: OrchestrationEvent["type"],
  payload: unknown,
  origin?: OrchestrationCommandOrigin,
): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: THREAD,
    occurredAt: T0,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: origin ? { origin } : {},
    payload: payload as never,
  } as OrchestrationEvent;
}

const project = (readModel: OrchestrationReadModel, next: OrchestrationEvent) =>
  Effect.runPromise(projectEvent(readModel, next));

const created = (origin?: OrchestrationCommandOrigin) =>
  project(
    createEmptyReadModel(T0),
    event(
      "thread.created",
      {
        threadId: THREAD,
        projectId: ProjectId.make("project-1"),
        title: "chat",
        modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5-codex" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: T0,
        updatedAt: T0,
      },
      origin,
    ),
  );

const userMessage = (id: string, at: string, origin?: OrchestrationCommandOrigin) =>
  event(
    "thread.message-sent",
    {
      threadId: THREAD,
      messageId: id,
      role: "user",
      text: "hi",
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
    origin,
  );

async function decideAndApply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
  origin?: OrchestrationCommandOrigin,
) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel, origin }),
  );
  const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<PlannedEvent>;
  let next = readModel;
  for (const planned of events) {
    next = await project(next, {
      ...planned,
      sequence: next.snapshotSequence + 1,
      metadata: origin ? { origin } : {},
    } as OrchestrationEvent);
  }
  return { events, readModel: next };
}

const call = (reason: string | null): OrchestrationCommand => ({
  type: "thread.person.call",
  commandId: CommandId.make(`cmd-call-${Math.random()}`),
  threadId: THREAD,
  reason: reason as never,
  createdAt: T1,
});

const release: OrchestrationCommand = {
  type: "thread.person.release",
  commandId: CommandId.make("cmd-release"),
  threadId: THREAD,
  createdAt: T2,
};

describe("who started a chat (thread.created origin)", () => {
  it.each([
    [undefined, null],
    [{ kind: "connector", connector: "telegram" }, null],
    [{ kind: "agent", threadId: CALLER }, "agent"],
    [{ kind: "manager" }, "assistant"],
    [{ kind: "assistant" }, "assistant"],
    [{ kind: "app", appId: "x" }, "app"],
    [{ kind: "system", component: "runtime-startup" }, null],
  ] as const)("origin %j starts a chat by %s", async (origin, startedBy) => {
    const readModel = await created(origin as OrchestrationCommandOrigin | undefined);
    expect(readModel.threads[0]?.startedBy ?? null).toBe(startedBy);
  });
});

describe("the person's own messages", () => {
  it("counts the UI and connectors, not agents or Uno", async () => {
    let readModel = await created({ kind: "agent", threadId: CALLER });
    readModel = await project(
      readModel,
      userMessage("m-agent", T1, { kind: "agent", threadId: CALLER }),
    );
    expect(readModel.threads[0]?.latestPersonMessageAt ?? null).toBeNull();
    readModel = await project(readModel, userMessage("m-uno", T1, UNO));
    expect(readModel.threads[0]?.latestPersonMessageAt ?? null).toBeNull();
    readModel = await project(readModel, userMessage("m-ui", T1));
    expect(readModel.threads[0]?.latestPersonMessageAt).toBe(T1);
    readModel = await project(
      readModel,
      userMessage("m-tg", T2, { kind: "connector", connector: "telegram" }),
    );
    expect(readModel.threads[0]?.latestPersonMessageAt).toBe(T2);
  });
});

describe("calling the person into a chat", () => {
  it("records who called and why, trimmed to 200 characters", async () => {
    const { events, readModel } = await decideAndApply(
      await created({ kind: "agent", threadId: CALLER }),
      call("глянь ".repeat(60).trim()),
      { kind: "agent", threadId: CALLER },
    );
    expect(events.map((planned) => planned.type)).toEqual(["thread.person-called"]);
    const thread = readModel.threads[0]!;
    expect(thread.personCalledAt).toBeTruthy();
    expect(thread.personCalledByThreadId).toBe(CALLER);
    expect((thread.personCallReason ?? "").length).toBeLessThanOrEqual(200);
  });

  it("leaves the caller empty when Uno or the system calls", async () => {
    const { readModel } = await decideAndApply(await created(UNO), call(null), UNO);
    expect(readModel.threads[0]?.personCalledAt).toBeTruthy();
    expect(readModel.threads[0]?.personCalledByThreadId).toBeNull();
    expect(readModel.threads[0]?.personCallReason).toBeNull();
  });

  it("releases a called chat and ignores a release with no call", async () => {
    const fresh = await created({ kind: "agent", threadId: CALLER });
    const noop = await decideAndApply(fresh, release, { kind: "agent", threadId: CALLER });
    expect(noop.events).toEqual([]);

    const called = await decideAndApply(fresh, call("готово"), {
      kind: "agent",
      threadId: CALLER,
    });
    const released = await decideAndApply(called.readModel, release, {
      kind: "agent",
      threadId: CALLER,
    });
    expect(released.events.map((planned) => planned.type)).toEqual(["thread.person-released"]);
    expect(released.readModel.threads[0]).toMatchObject({
      personCalledAt: null,
      personCalledByThreadId: null,
      personCallReason: null,
    });
  });

  it("rejects a call into a missing chat", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: call(null),
          readModel: createEmptyReadModel(T0),
          origin: { kind: "agent", threadId: CALLER },
        }),
      ),
    ).rejects.toThrow();
  });
});
