/**
 * resync-bytes: how many bytes a client downloads when it reconnects, with the
 * real orchestration engine, projections and SQLite (in memory).
 *
 *   cd apps/server && nice -n 19 bun scripts/resync-bytes.ts [--long-turns 120] [--cached 31]
 *
 * Seeds one long chat (open on screen), `--cached` other chats the client keeps
 * warm, applies an "outage" (a turn in the open chat and one in a background
 * chat), then prints the bytes of the frames the server sends on reconnect:
 *
 *  - full:   what every reconnect cost before resume (shell snapshot + one full
 *            snapshot per warm chat subscription) — also what an old server sends;
 *  - resume: shell resume + resume of the open chat (idle cached chats stay parked);
 *  - deflate: the same full resync compressed per frame (permessage-deflate
 *            without context takeover), to size the compression option.
 *
 * Frames are the effect RPC JSON wire messages ({_tag:"Chunk",requestId,values}).
 */
import { deflateRawSync } from "node:zlib";
import { parseArgs } from "node:util";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { planShellResume, planThreadResume } from "../src/orchestration/subscriptionResume.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../src/project/Layers/RepositoryIdentityResolver.ts";

const { values: flags } = parseArgs({
  options: {
    "long-turns": { type: "string", default: "120" },
    "cached-turns": { type: "string", default: "15" },
    cached: { type: "string", default: "31" },
  },
});
const LONG_TURNS = Number(flags["long-turns"]);
const CACHED_TURNS = Number(flags["cached-turns"]);
const CACHED_THREADS = Number(flags.cached);
const DELTAS_PER_REPLY = 30;
const ACTIVITIES_PER_TURN = 6;

const layer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "uno-resync-bytes-" })),
  Layer.provideMerge(NodeServices.layer),
);

const DETAIL_EVENT_TYPES = new Set([
  "thread.message-sent",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
]);

const prose = (seed: number, length: number) => {
  const words = ["the", "build", "passes", "now", "after", "fixing", "imports", "in", "server"];
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += `${words[(seed + i * 7) % words.length]} `;
  return out.slice(0, length);
};

const program = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  let commandCounter = 0;
  const cmd = () => CommandId.make(`cmd-${(commandCounter += 1)}`);
  const at = () => new Date().toISOString();
  const projectId = ProjectId.make("project-1");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

  yield* engine.dispatch({
    type: "project.create",
    commandId: cmd(),
    projectId,
    title: "Uno Work",
    workspaceRoot: "/tmp/uno-work",
    defaultModelSelection: modelSelection,
    createdAt: at(),
  });

  const createThread = (threadId: ThreadId, title: string) =>
    engine.dispatch({
      type: "thread.create",
      commandId: cmd(),
      threadId,
      projectId,
      title,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: at(),
    });

  const turn = (threadId: ThreadId, index: number) =>
    Effect.gen(function* () {
      const turnId = TurnId.make(`${threadId}-turn-${index}`);
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: cmd(),
        threadId,
        messageId: MessageId.make(`${threadId}-user-${index}`),
        text: prose(index, 220),
        createdAt: at(),
      });
      for (let a = 0; a < ACTIVITIES_PER_TURN; a += 1) {
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: cmd(),
          threadId,
          activity: {
            id: EventId.make(`${threadId}-act-${index}-${a}`),
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { command: "bun run typecheck", output: prose(index + a, 500) },
            turnId,
            createdAt: at(),
          },
          createdAt: at(),
        });
      }
      const messageId = MessageId.make(`${threadId}-assistant-${index}`);
      for (let d = 0; d < DELTAS_PER_REPLY; d += 1) {
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: cmd(),
          threadId,
          messageId,
          delta: prose(index + d, 50),
          turnId,
          createdAt: at(),
        });
      }
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: cmd(),
        threadId,
        messageId,
        turnId,
        createdAt: at(),
      });
    });

  const openThread = ThreadId.make("thread-open");
  yield* createThread(openThread, "Long chat");
  for (let i = 0; i < LONG_TURNS; i += 1) yield* turn(openThread, i);
  const cachedThreads = Array.from({ length: CACHED_THREADS }, (_, i) =>
    ThreadId.make(`thread-cached-${i}`),
  );
  for (const threadId of cachedThreads) {
    yield* createThread(threadId, `Chat ${threadId}`);
    for (let i = 0; i < CACHED_TURNS; i += 1) yield* turn(threadId, i);
  }
  // A handful of other chats in the sidebar that the client does not keep warm.
  for (let i = 0; i < 40; i += 1) yield* createThread(ThreadId.make(`thread-other-${i}`), "Old");

  // Cursors the client holds when the link drops.
  const { snapshotSequence: cursor } = yield* query.getSnapshotSequence();

  // The outage: the open chat gets a reply, a background chat finishes a turn.
  yield* turn(openThread, LONG_TURNS);
  yield* turn(cachedThreads[0]!, CACHED_TURNS);
  const { snapshotSequence: current } = yield* query.getSnapshotSequence();

  const frame = (values: ReadonlyArray<unknown>) =>
    JSON.stringify({ _tag: "Chunk", requestId: "1", values });

  // ---- full resync (v0.0.159 behaviour, and any server without resume)
  const shellSnapshot = yield* query.getShellSnapshot();
  const fullFrames = [frame([{ kind: "snapshot", snapshot: shellSnapshot }])];
  for (const threadId of [openThread, ...cachedThreads]) {
    const detail = yield* query.getThreadDetailById(threadId);
    fullFrames.push(
      frame([
        {
          kind: "snapshot",
          snapshot: { snapshotSequence: current, thread: Option.getOrThrow(detail) },
        },
      ]),
    );
  }

  // ---- resume
  const readAll = (from: number, limit: number) =>
    Stream.runCollect(engine.readEvents(from, { limit })).pipe(Effect.map((c) => Array.from(c)));
  const toShellEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>> =>
    event.aggregateKind === "project"
      ? query.getProjectShellById(ProjectId.make(event.aggregateId)).pipe(
          Effect.map(
            Option.map((project) => ({
              kind: "project-upserted" as const,
              sequence: event.sequence,
              project,
            })),
          ),
          Effect.orElseSucceed(() => Option.none()),
        )
      : query.getThreadShellById(ThreadId.make(event.aggregateId)).pipe(
          Effect.map(
            Option.map((thread) => ({
              kind: "thread-upserted" as const,
              sequence: event.sequence,
              thread,
            })),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );
  const shellPlan = yield* planShellResume({
    cursor,
    currentSequence: current,
    readEvents: readAll,
    toShellEvent,
  });
  const threadPlan = yield* planThreadResume({
    threadId: openThread,
    cursor,
    currentSequence: current,
    threadExists: Effect.succeed(true),
    readThreadEvents: (from, limit) =>
      Stream.runCollect(
        engine.readEvents(from, { limit, aggregate: { kind: "thread", id: openThread } }),
      ).pipe(Effect.map((c) => Array.from(c))),
    isDetailEvent: (event) => DETAIL_EVENT_TYPES.has(event.type),
  });
  if (shellPlan.kind !== "replay" || threadPlan.kind !== "replay") {
    throw new Error(`resume fell back: ${shellPlan.kind}/${threadPlan.kind}`);
  }
  // Items are streamed one chunk each, like the live stream.
  const resumeFrames = [
    ...shellPlan.items.map((item) => frame([item])),
    frame([{ kind: "resumed", sequence: shellPlan.lastSequence }]),
    ...threadPlan.items.map((event) => frame([{ kind: "event", event }])),
    frame([{ kind: "resumed", sequence: threadPlan.lastSequence }]),
  ];

  const bytes = (frames: ReadonlyArray<string>) =>
    frames.reduce((sum, f) => sum + Buffer.byteLength(f), 0);
  const deflated = (frames: ReadonlyArray<string>) =>
    frames.reduce((sum, f) => sum + deflateRawSync(Buffer.from(f)).byteLength, 0);

  const gapEvents = (yield* readAll(cursor, 100_000)).length;
  const result = {
    seeded: {
      openChatTurns: LONG_TURNS,
      cachedChats: CACHED_THREADS,
      cachedChatTurns: CACHED_TURNS,
      eventsTotal: current,
      eventsInOutage: gapEvents,
    },
    fullResync: {
      frames: fullFrames.length,
      bytes: bytes(fullFrames),
      shellSnapshotBytes: Buffer.byteLength(fullFrames[0]!),
      openChatSnapshotBytes: Buffer.byteLength(fullFrames[1]!),
      deflatedBytes: deflated(fullFrames),
    },
    resume: {
      frames: resumeFrames.length,
      bytes: bytes(resumeFrames),
      shellItems: shellPlan.items.length,
      openChatItems: threadPlan.items.length,
      deflatedBytes: deflated(resumeFrames),
    },
  };
  console.log(JSON.stringify(result, null, 2));
});

const runtime = ManagedRuntime.make(layer);
await runtime.runPromise(program);
await runtime.dispose();
