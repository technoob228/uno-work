import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option, PubSub, Stream } from "effect";

import {
  latestEventPerAggregate,
  liveAfter,
  planShellResume,
  planThreadResume,
  subscribeNow,
} from "./subscriptionResume.ts";

const NOW = "2026-10-29T12:00:00.000Z";
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const PROJECT = ProjectId.make("project-1");

function messageEvent(input: {
  readonly sequence: number;
  readonly threadId?: ThreadId;
  readonly messageId?: string;
  readonly text?: string;
  readonly streaming?: boolean;
}): OrchestrationEvent {
  const threadId = input.threadId ?? THREAD_A;
  return {
    sequence: input.sequence,
    eventId: EventId.make(`evt-${input.sequence}`),
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(input.messageId ?? `msg-${input.sequence}`),
      role: "assistant",
      text: input.text ?? `text ${input.sequence}`,
      turnId: null,
      streaming: input.streaming ?? false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationEvent;
}

function threadDeletedEvent(sequence: number, threadId: ThreadId): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`evt-${sequence}`),
    type: "thread.deleted",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, deletedAt: NOW },
  } as OrchestrationEvent;
}

function projectEvent(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`evt-${sequence}`),
    type: "project.meta-updated",
    aggregateKind: "project",
    aggregateId: PROJECT,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { projectId: PROJECT, title: "P", updatedAt: NOW },
  } as OrchestrationEvent;
}

/** Shell translation stub: removed for deletes, an upsert marker otherwise. */
const toShellEvent = (event: OrchestrationEvent) =>
  Effect.succeed(
    Option.some(
      (event.type === "thread.deleted"
        ? { kind: "thread-removed", sequence: event.sequence, threadId: event.aggregateId }
        : event.aggregateKind === "project"
          ? { kind: "project-removed", sequence: event.sequence, projectId: event.aggregateId }
          : {
              kind: "thread-upserted",
              sequence: event.sequence,
              thread: { id: event.aggregateId },
            }) as unknown as OrchestrationShellStreamEvent,
    ),
  );

const readFrom =
  (events: ReadonlyArray<OrchestrationEvent>) =>
  (cursor: number, limit: number): Effect.Effect<ReadonlyArray<OrchestrationEvent>> =>
    Effect.succeed(events.filter((event) => event.sequence > cursor).slice(0, limit));

it("keeps only the newest event per aggregate, oldest first", () => {
  const events = [
    messageEvent({ sequence: 11, threadId: THREAD_A }),
    projectEvent(12),
    messageEvent({ sequence: 13, threadId: THREAD_B }),
    messageEvent({ sequence: 14, threadId: THREAD_A }),
  ];
  assert.deepEqual(
    latestEventPerAggregate(events).map((event) => event.sequence),
    [12, 13, 14],
  );
});

it.effect("shell: replays one change per touched aggregate and reports the last sequence", () =>
  Effect.gen(function* () {
    const store = [
      messageEvent({ sequence: 10 }),
      messageEvent({ sequence: 11, threadId: THREAD_A }),
      messageEvent({ sequence: 12, threadId: THREAD_B }),
      messageEvent({ sequence: 13, threadId: THREAD_A }),
      threadDeletedEvent(14, THREAD_B),
    ];
    const plan = yield* planShellResume({
      cursor: 10,
      currentSequence: 14,
      readEvents: readFrom(store),
      toShellEvent,
    });
    assert.equal(plan.kind, "replay");
    if (plan.kind !== "replay") return;
    assert.deepEqual(
      plan.items.map((item) => [item.kind, item.sequence]),
      [
        ["thread-upserted", 13],
        ["thread-removed", 14],
      ],
    );
    assert.equal(plan.lastSequence, 14);
  }),
);

it.effect("shell: an empty gap resumes with the cursor as the last sequence", () =>
  Effect.gen(function* () {
    const plan = yield* planShellResume({
      cursor: 20,
      currentSequence: 20,
      readEvents: readFrom([]),
      toShellEvent,
    });
    assert.deepEqual(plan, { kind: "replay", items: [], lastSequence: 20 });
  }),
);

it.effect(
  "shell: falls back to a snapshot without a cursor, ahead of the server, or a big gap",
  () =>
    Effect.gen(function* () {
      const store = Array.from({ length: 6 }, (_, index) => messageEvent({ sequence: index + 1 }));
      const base = { readEvents: readFrom(store), toShellEvent, currentSequence: 6 } as const;

      assert.deepEqual(yield* planShellResume({ ...base, cursor: undefined }), {
        kind: "snapshot",
        reason: "no-cursor",
      });
      // Cursor beyond what this server has: e.g. a reset database.
      assert.deepEqual(yield* planShellResume({ ...base, cursor: 99 }), {
        kind: "snapshot",
        reason: "cursor-ahead",
      });
      assert.deepEqual(yield* planShellResume({ ...base, cursor: 1, maxEvents: 4 }), {
        kind: "snapshot",
        reason: "gap-too-large",
      });
    }),
);

it.effect("thread: replays only this chat's detail events, deltas folded per message", () =>
  Effect.gen(function* () {
    const store = [
      messageEvent({ sequence: 5, messageId: "m1", text: "Hel", streaming: true }),
      messageEvent({ sequence: 6, messageId: "m1", text: "lo", streaming: true }),
      messageEvent({ sequence: 7, threadId: THREAD_B, messageId: "other" }),
      messageEvent({ sequence: 8, messageId: "m1", text: "!", streaming: true }),
      messageEvent({ sequence: 9, messageId: "m2", text: "next" }),
    ];
    const plan = yield* planThreadResume({
      threadId: THREAD_A,
      cursor: 4,
      currentSequence: 9,
      threadExists: Effect.succeed(true),
      // The real read is already per-aggregate; the stub returns everything to
      // prove the plan filters other chats out anyway.
      readThreadEvents: readFrom(store),
      isDetailEvent: (event) => event.type === "thread.message-sent",
    });
    assert.equal(plan.kind, "replay");
    if (plan.kind !== "replay") return;
    assert.deepEqual(
      plan.items.map((event) => [
        event.sequence,
        event.type === "thread.message-sent" ? event.payload.text : null,
      ]),
      [
        [8, "Hello!"],
        [9, "next"],
      ],
    );
    assert.equal(plan.lastSequence, 9);
  }),
);

it.effect("thread: missing chat, unknown cursor and too many items fall back to a snapshot", () =>
  Effect.gen(function* () {
    const store = Array.from({ length: 5 }, (_, index) => messageEvent({ sequence: index + 1 }));
    const base = {
      threadId: THREAD_A,
      currentSequence: 5,
      threadExists: Effect.succeed(true),
      readThreadEvents: readFrom(store),
      isDetailEvent: () => true,
    } as const;

    assert.equal((yield* planThreadResume({ ...base, cursor: 0 })).kind, "snapshot");
    assert.deepEqual(yield* planThreadResume({ ...base, cursor: 6 }), {
      kind: "snapshot",
      reason: "cursor-ahead",
    });
    assert.deepEqual(
      yield* planThreadResume({ ...base, cursor: 1, threadExists: Effect.succeed(false) }),
      { kind: "snapshot", reason: "not-found" },
    );
    assert.deepEqual(yield* planThreadResume({ ...base, cursor: 1, maxItems: 2 }), {
      kind: "snapshot",
      reason: "gap-too-large",
    });
    assert.deepEqual(yield* planThreadResume({ ...base, cursor: 1, maxEvents: 3 }), {
      kind: "snapshot",
      reason: "gap-too-large",
    });
  }),
);

it.effect("live events published while history is read are neither lost nor duplicated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
      const live = yield* subscribeNow(Stream.fromPubSub(pubsub));

      // Committed before the read and published late (overlap: 3), then
      // committed after the read (gap: 4, 5).
      for (const sequence of [3, 4, 5]) {
        yield* PubSub.publish(pubsub, messageEvent({ sequence }));
      }

      const store = [1, 2, 3].map((sequence) => messageEvent({ sequence }));
      const plan = yield* planThreadResume({
        threadId: THREAD_A,
        cursor: 1,
        currentSequence: 3,
        threadExists: Effect.succeed(true),
        readThreadEvents: readFrom(store),
        isDetailEvent: () => true,
      });
      assert.equal(plan.kind, "replay");
      if (plan.kind !== "replay") return;

      const delivered = yield* Stream.concat(
        Stream.fromIterable(plan.items),
        liveAfter(live, plan.lastSequence),
      ).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk, (event) => event.sequence)),
      );
      assert.deepEqual(delivered, [2, 3, 4, 5]);
    }),
  ),
);
