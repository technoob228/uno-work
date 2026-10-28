import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { SessionCredentialService } from "../../auth/Services/SessionCredentialService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ConnectorNotifyService } from "../Services/ConnectorNotify.ts";
import { TaskDoneNotifyLive } from "./TaskDoneNotify.ts";

const threadId = ThreadId.make("thread-1");
const t0 = Date.parse("2026-10-28T10:00:00.000Z");
let sequence = 0;

const base = (atMs: number) => ({
  sequence: ++sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: new Date(atMs).toISOString(),
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const message = (atMs: number): OrchestrationEvent => ({
  ...base(atMs),
  type: "thread.turn-start-requested",
  payload: {
    threadId,
    messageId: MessageId.make(`message-${sequence}`),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date(atMs).toISOString(),
  },
});

const session = (
  atMs: number,
  status: OrchestrationSession["status"],
  activeTurnId: string | null = null,
): OrchestrationEvent => ({
  ...base(atMs),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status,
      providerName: "opencode",
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt: new Date(atMs).toISOString(),
    },
  },
});

const longTask = (minutes: number) => [
  message(t0),
  session(t0 + 1_000, "running", "turn-1"),
  session(t0 + minutes * 60_000, "ready"),
];

async function runForwarder(input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly connected: boolean;
  readonly notifyOnComplete?: boolean;
  readonly projectId?: string;
  readonly identity?: boolean;
}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ linked: true, sent: true }), { status: 200 });
    }),
  );
  const layer = TaskDoneNotifyLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          streamDomainEvents: Stream.fromIterable(input.events),
        } as never),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: threadId,
                projectId: ProjectId.make(input.projectId ?? "project-1"),
                title: "TODO API with tests",
              }),
            ),
        } as never),
        Layer.succeed(ConnectorNotifyService, {
          resolveChats: () =>
            Effect.succeed(
              input.notifyOnComplete
                ? [{ kind: "telegram", chatId: "1", notifyOnComplete: true }]
                : [],
            ),
        } as never),
        Layer.succeed(SessionCredentialService, {
          listActive: () => Effect.succeed([{ connected: input.connected }]),
        } as never),
        Layer.succeed(ServerSettingsService, {
          getSettings: Effect.succeed({
            uno: input.identity === false ? {} : { boxToken: "box-token", boxId: 2298 },
          }),
        } as never),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        // Let the forked stream drain.
        yield* Effect.sleep("50 millis");
      }),
    ),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskDoneNotify", () => {
  it("a long task ends with no Uno Work open: one notice through the console", async () => {
    const calls = await runForwarder({ events: longTask(8), connected: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/v1\/boxes\/2298\/work\/notify-owner$/);
    expect(calls[0]!.body).toEqual({
      text: 'Your agent finished "TODO API with tests" (8 min). Open Uno Work to see the result: https://app.uno4.work',
      email_subject: "Your agent finished: TODO API with tests",
    });
  });

  it("nothing while a tab is open, for a short task, off a cloud computer, or for the assistant", async () => {
    expect(await runForwarder({ events: longTask(8), connected: true })).toEqual([]);
    expect(await runForwarder({ events: longTask(1), connected: false })).toEqual([]);
    expect(await runForwarder({ events: longTask(8), connected: false, identity: false })).toEqual(
      [],
    );
    expect(
      await runForwarder({
        events: longTask(8),
        connected: false,
        projectId: "assistant-uno",
      }),
    ).toEqual([]);
  });

  it("a chat bound with 'tell me when done' already hears it", async () => {
    expect(
      await runForwarder({ events: longTask(8), connected: false, notifyOnComplete: true }),
    ).toEqual([]);
  });
});
