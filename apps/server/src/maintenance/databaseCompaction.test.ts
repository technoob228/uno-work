import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  compactThreadMessages,
  foldMessageEvents,
  readCompactionWatermarks,
  runCompactionPass,
} from "./databaseCompaction.ts";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const OLD = "2026-08-01T10:00:00.000Z";
const WEEKS_AGO = "2026-10-15T10:00:00.000Z";
const RECENT = "2026-10-30T11:00:00.000Z";
const PROJECTOR_COUNT = Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length;

const passOptions = {
  now: NOW,
  pause: Effect.void,
  projectorCount: PROJECTOR_COUNT,
  keepRecentEvents: 3,
};

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-compaction-test-" })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

let eventCounter = 0;
const base = (aggregateKind: "project" | "thread", aggregateId: string, occurredAt: string) => {
  eventCounter += 1;
  return {
    eventId: EventId.make(`evt-${eventCounter}`),
    aggregateKind,
    aggregateId: aggregateId as ProjectId & ThreadId,
    occurredAt,
    commandId: CommandId.make(`cmd-${eventCounter}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${eventCounter}`),
    metadata: {},
  };
};

const addThread = (threadId: string, at: string) =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    yield* store.append({
      ...base("project", `project-${threadId}`, at),
      type: "project.created",
      payload: {
        projectId: ProjectId.make(`project-${threadId}`),
        title: "P",
        workspaceRoot: `/tmp/${threadId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    yield* store.append({
      ...base("thread", threadId, at),
      type: "thread.created",
      payload: {
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make(`project-${threadId}`),
        title: "T",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    } as never);
  });

const messageEvent = (
  threadId: string,
  messageId: string,
  input: {
    readonly text: string;
    readonly streaming: boolean;
    readonly at: string;
    readonly role?: "user" | "assistant";
  },
) =>
  Effect.flatMap(OrchestrationEventStore.asEffect(), (store) =>
    store.append({
      ...base("thread", threadId, input.at),
      type: "thread.message-sent",
      payload: {
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(messageId),
        role: input.role ?? "assistant",
        text: input.text,
        turnId: TurnId.make(`turn-${messageId}`),
        streaming: input.streaming,
        createdAt: input.at,
        updatedAt: input.at,
      },
    } as never),
  );

/** How a streamed answer lands in the log: deltas, then a final event with no text. */
const streamedMessage = (
  threadId: string,
  messageId: string,
  deltas: ReadonlyArray<string>,
  at: string,
) =>
  Effect.gen(function* () {
    for (const delta of deltas) {
      yield* messageEvent(threadId, messageId, { text: delta, streaming: true, at });
    }
    yield* messageEvent(threadId, messageId, { text: "", streaming: false, at });
  });

const activityEvent = (threadId: string, activityId: string, at: string) =>
  Effect.flatMap(OrchestrationEventStore.asEffect(), (store) =>
    store.append({
      ...base("thread", threadId, at),
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make(threadId),
        activity: {
          id: EventId.make(activityId),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran a command",
          payload: { output: "x".repeat(200) },
          turnId: null,
          createdAt: at,
        },
      },
    } as never),
  );

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "orchestration_events",
    "orchestration_command_receipts",
    "projection_thread_messages",
    "projection_thread_activities",
    "projection_threads",
    "projection_projects",
    "projection_state",
    "database_compaction_state",
  ]) {
    yield* sql.unsafe(`DELETE FROM ${table}`);
  }
});

const messageRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Record<string, unknown>>`
    SELECT message_id, thread_id, turn_id, role, text, is_streaming, created_at
    FROM projection_thread_messages
    ORDER BY message_id
  `;
});

const eventCount = (type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = ${type}
    `;
    return rows[0]?.count ?? 0;
  });

/** Throws the message projection away and builds it again from the compacted log. */
const replayMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pipeline = yield* OrchestrationProjectionPipeline;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`
    UPDATE projection_state SET last_applied_sequence = 0
    WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
  `;
  yield* pipeline.bootstrap;
  return yield* messageRows;
});

const padding = (threadId: string) =>
  Effect.gen(function* () {
    for (let index = 0; index < 5; index += 1) {
      yield* messageEvent(threadId, `pad-${index}`, {
        text: `recent ${index}`,
        streaming: false,
        at: RECENT,
        role: "user",
      });
    }
  });

const delta = (sequence: number, text: string) => ({
  sequence,
  payload: { text, streaming: true, createdAt: `t${sequence}` },
});
const final = (sequence: number, text = "") => ({
  sequence,
  payload: { text, streaming: false, createdAt: `t${sequence}` },
});

describe("foldMessageEvents", () => {
  it("folds deltas into the last event, with the first one's time", () => {
    const fold = foldMessageEvents([delta(1, "Hel"), delta(2, "lo"), final(3)], null);
    assert.deepStrictEqual(fold, {
      keepSequence: 3,
      payload: { text: "Hello", streaming: false, createdAt: "t1" },
      removeSequences: [1, 2],
    });
  });

  it("takes what the chat shows: secrets are masked there", () => {
    const fold = foldMessageEvents([delta(1, "key sk-"), delta(2, "secret"), final(3)], {
      text: "key ***",
    });
    assert.strictEqual(fold?.payload.text, "key ***");
  });

  it("a final event with text replaces the deltas, as in the projector", () => {
    const fold = foldMessageEvents([delta(1, "draft"), final(2, "final")], null);
    assert.strictEqual(fold?.payload.text, "final");
  });

  it("keeps an unfinished message unfinished, and does not take the whole text for a part", () => {
    const fold = foldMessageEvents([delta(1, "a"), delta(2, "b")], { text: "ab and more" });
    assert.strictEqual(fold?.payload.text, "ab");
    assert.strictEqual(fold?.payload.streaming, true);
  });

  it("keeps attachments and who sent it", () => {
    const fold = foldMessageEvents(
      [
        { sequence: 1, payload: { text: "a", attachments: [{ id: "x" }], sentByThreadId: "t" } },
        final(2),
      ],
      null,
    );
    assert.deepStrictEqual(fold?.payload.attachments, [{ id: "x" }]);
    assert.strictEqual(fold?.payload.sentByThreadId, "t");
  });

  it("has nothing to do with one event, and refuses to lose text", () => {
    assert.strictEqual(foldMessageEvents([final(1, "x")], null), null);
    assert.strictEqual(foldMessageEvents([delta(1, "text"), final(2)], { text: "" }), null);
  });
});

layer("database compaction", (it) => {
  it.effect("folds old messages and a rebuild from the log gives the same chat", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* addThread("t-1", OLD);
      yield* messageEvent("t-1", "m-user", {
        text: "Where is the bug?",
        streaming: false,
        at: OLD,
        role: "user",
      });
      yield* streamedMessage("t-1", "m-a", ["The ", "bug ", "is ", "here."], OLD);
      yield* streamedMessage("t-1", "m-b", ["Привет, ", "мир"], OLD);
      yield* padding("t-1");
      yield* pipeline.bootstrap;
      const before = yield* messageRows;
      const eventsBefore = yield* eventCount("thread.message-sent");

      const result = yield* Effect.flatMap(SqlClient.SqlClient.asEffect(), (sql) =>
        runCompactionPass(sql, passOptions),
      );

      assert.strictEqual(result.foldedMessages, 2);
      assert.strictEqual(result.removedMessageEvents, 6);
      assert.strictEqual(yield* eventCount("thread.message-sent"), eventsBefore - 6);
      assert.deepStrictEqual(yield* messageRows, before);
      assert.deepStrictEqual(yield* replayMessages, before);
    }),
  );

  it.effect("leaves the newest events and recent messages alone", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-2", OLD);
      yield* streamedMessage("t-2", "m-new", ["a", "b"], RECENT);
      yield* padding("t-2");
      yield* pipeline.bootstrap;
      const result = yield* runCompactionPass(sql, passOptions);
      assert.strictEqual(result.foldedMessages, 0);
      assert.strictEqual(yield* eventCount("thread.message-sent"), 8);
    }),
  );

  it.effect("waits for a message still streaming, then folds it", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-3", OLD);
      yield* messageEvent("t-3", "m-open", { text: "par", streaming: true, at: OLD });
      yield* messageEvent("t-3", "m-open", { text: "tial", streaming: true, at: OLD });
      yield* pipeline.bootstrap;
      const watermark = 100_000;
      const options = { now: NOW, pause: Effect.void };
      const first = yield* compactThreadMessages(sql, "t-3", watermark, options);
      assert.strictEqual(first.foldedMessages, 0);
      yield* messageEvent("t-3", "m-open", { text: "", streaming: false, at: OLD });
      yield* pipeline.bootstrap;
      const second = yield* compactThreadMessages(sql, "t-3", watermark, options);
      assert.strictEqual(second.foldedMessages, 1);
      const rows = yield* replayMessages;
      assert.strictEqual(rows[0]?.text, "partial");
    }),
  );

  it.effect("does nothing while a projector is behind or missing", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-4", OLD);
      yield* streamedMessage("t-4", "m-behind", ["a", "b"], OLD);
      yield* padding("t-4");
      yield* pipeline.bootstrap;
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 0
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}
      `;
      const behind = yield* readCompactionWatermarks(sql, NOW, PROJECTOR_COUNT, 0);
      assert.deepStrictEqual(behind, { messages: 0, activities: 0 });
      yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}
      `;
      const missing = yield* readCompactionWatermarks(sql, NOW, PROJECTOR_COUNT, 0);
      assert.deepStrictEqual(missing, { messages: 0, activities: 0 });
    }),
  );

  it.effect("drops old activity events, keeps what the chat shows and recent ones", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-5", OLD);
      yield* activityEvent("t-5", "a-old", OLD);
      yield* activityEvent("t-5", "a-weeks", WEEKS_AGO);
      yield* padding("t-5");
      yield* pipeline.bootstrap;
      const before = yield* sql`
        SELECT activity_id, payload_json FROM projection_thread_activities ORDER BY activity_id
      `;
      const result = yield* runCompactionPass(sql, passOptions);
      assert.strictEqual(result.removedActivityEvents, 1);
      assert.strictEqual(yield* eventCount("thread.activity-appended"), 1);
      assert.deepStrictEqual(
        yield* sql`
          SELECT activity_id, payload_json FROM projection_thread_activities ORDER BY activity_id
        `,
        before,
      );
    }),
  );

  it.effect("a second pass finds nothing, and new events still append after folding", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-6", OLD);
      yield* streamedMessage("t-6", "m-once", ["a", "b"], OLD);
      yield* padding("t-6");
      yield* pipeline.bootstrap;
      yield* runCompactionPass(sql, passOptions);
      const again = yield* runCompactionPass(sql, passOptions);
      assert.strictEqual(again.foldedMessages, 0);
      assert.strictEqual(again.removedActivityEvents, 0);
      yield* messageEvent("t-6", "m-next", { text: "after", streaming: false, at: RECENT });
      yield* pipeline.bootstrap;
      assert.strictEqual((yield* messageRows).length, 7);
    }),
  );

  it.effect("removes the receipts of folded commands only", () =>
    Effect.gen(function* () {
      yield* reset;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-7", OLD);
      yield* streamedMessage("t-7", "m-receipts", ["a", "b"], OLD);
      yield* padding("t-7");
      yield* pipeline.bootstrap;
      const commands = yield* sql<{ readonly commandId: string; readonly sequence: number }>`
        SELECT command_id AS "commandId", sequence FROM orchestration_events ORDER BY sequence
      `;
      for (const { commandId, sequence } of commands) {
        yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status
          )
          VALUES (${commandId}, 'thread', 't-7', ${OLD}, ${sequence}, 'accepted')
        `;
      }
      const result = yield* runCompactionPass(sql, passOptions);
      assert.strictEqual(result.removedReceipts, 2);
      const left = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_command_receipts
      `;
      assert.strictEqual(left[0]?.count, commands.length - 2);
    }),
  );
});
