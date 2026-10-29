import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { type OrchestrationCommand, ThreadId, TurnId } from "@t3tools/contracts";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { UPDATE_RESTART_NOTE_BODY } from "@t3tools/shared/turnErrorRetry";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ManagerConnectorPendingReplyRepository,
  type ConnectorPendingReply,
} from "./persistence/Services/ManagerConnectorPendingReplies.ts";
import { makeSelfUpdateController } from "./selfUpdate.ts";
import {
  readContinuedThreads,
  readDeferredUpdate,
  readTurnsSnapshot,
  writeDeferredUpdate,
  writeTurnsSnapshot,
  deferredUpdateFor,
  DEFERRED_UPDATE_IDLE_MS,
} from "./selfUpdateTurns.ts";
import {
  SELF_UPDATE_CONTINUE_COMMAND_PREFIX,
  continueTurnsAfterSelfUpdateWith,
  makeSelfUpdateWatcherTick,
} from "./selfUpdateTurnsRuntime.ts";

const SHA = "7a3d3d22cacdcc83ac4c04e2eb58de101c6617248a502dc5bf01d3c4f743bd72";
const SUMS = `${SHA}  uno-work-server-0.0.164.tar.gz\n${SHA}  uno-work-server-latest.tar.gz\n`;
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "uno-self-update-runtime-"));
  mkdirSync(join(root, "status"), { recursive: true });
  const paths = {
    requestFile: join(root, "update", "request"),
    statusFile: join(root, "status", "status.json"),
    baseUrl: "https://console.uno.place/cli/work",
  };
  const controller = makeSelfUpdateController({
    paths,
    currentVersion: "0.0.163",
    fetchImpl: (async () => new Response(SUMS, { status: 200 })) as unknown as typeof fetch,
  });
  return { stateDir: join(root, "state"), paths, controller };
}

const makeThread = (
  id: string,
  session: { status: "running" | "ready" | "error"; activeTurnId: TurnId | null },
  latestTurn: { turnId: TurnId; state: "running" | "interrupted" | "completed" } | null,
) => ({
  id: ThreadId.make(id),
  archivedAt: null,
  deletedAt: null,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    providerName: "claudeAgent",
    runtimeMode: "full-access" as const,
    lastError: null,
    updatedAt: iso(Date.now()),
    ...session,
  },
  latestTurn: latestTurn
    ? {
        ...latestTurn,
        requestedAt: iso(Date.now() - 5 * 60_000),
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      }
    : null,
});

type FakeThread = ReturnType<typeof makeThread>;

const provide =
  (input: {
    readonly threads: ReadonlyArray<FakeThread>;
    readonly dispatched?: OrchestrationCommand[];
    readonly openConnectorThreads?: ReadonlyArray<string>;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: input.threads } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => input.dispatched?.push(command)).pipe(Effect.as({ sequence: 1 })),
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ManagerConnectorPendingReplyRepository, {
        listByThread: ({ threadId }: { threadId: ThreadId }) =>
          Effect.succeed(
            (input.openConnectorThreads ?? []).includes(threadId)
              ? [{ threadId, status: "waiting" } as unknown as ConnectorPendingReply]
              : [],
          ),
      } as unknown as ManagerConnectorPendingReplyRepository["Service"]),
    );

it.effect("after an update restart, continues each cut-off chat once with a short note", () => {
  const { stateDir, paths, controller } = setup();
  const processStartedAt = Date.now();
  const runStartedAt = iso(processStartedAt - 90_000);
  writeFileSync(
    paths.statusFile,
    JSON.stringify({
      state: "done",
      fromVersion: "0.0.163",
      toVersion: "0.0.164",
      startedAt: runStartedAt,
      updatedAt: iso(processStartedAt),
      finishedAt: iso(processStartedAt),
    }),
  );
  const threads = [
    makeThread(
      "cut",
      { status: "error", activeTurnId: null },
      { turnId: TurnId.make("turn-cut"), state: "interrupted" },
    ),
    makeThread(
      "telegram",
      { status: "error", activeTurnId: null },
      { turnId: TurnId.make("turn-tg"), state: "interrupted" },
    ),
    makeThread(
      "finished",
      { status: "ready", activeTurnId: null },
      { turnId: TurnId.make("turn-fin"), state: "completed" },
    ),
  ];
  const dispatched: OrchestrationCommand[] = [];
  const snapshotTurns = [
    { threadId: "cut", turnId: "turn-cut" },
    { threadId: "telegram", turnId: "turn-tg" },
    { threadId: "finished", turnId: "turn-fin" },
  ];
  const continueOnce = continueTurnsAfterSelfUpdateWith({
    stateDir,
    controller,
    processStartedAt,
  }).pipe(provide({ threads, dispatched, openConnectorThreads: ["telegram"] }));

  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      writeTurnsSnapshot(stateDir, snapshotTurns, processStartedAt - 3_000),
    );
    yield* continueOnce;

    assert.strictEqual(dispatched.length, 1);
    const command = dispatched[0]!;
    assert.strictEqual(command.type, "thread.turn.start");
    if (command.type !== "thread.turn.start") return;
    assert.strictEqual(command.threadId, ThreadId.make("cut"));
    assert.ok(command.commandId.startsWith(SELF_UPDATE_CONTINUE_COMMAND_PREFIX));
    assert.strictEqual(command.message.text, `${UNO_WORK_NOTE_PREFIX}${UPDATE_RESTART_NOTE_BODY}`);
    assert.strictEqual(command.runtimeMode, "full-access");
    // The snapshot is used up; the chat is recorded against this update.
    assert.isNull(yield* Effect.promise(() => readTurnsSnapshot(stateDir)));
    assert.deepStrictEqual(
      [...(yield* Effect.promise(() => readContinuedThreads(stateDir, runStartedAt)))],
      ["cut"],
    );

    // The same update restarts us again (a rollback): no second continuation.
    yield* Effect.promise(() =>
      writeTurnsSnapshot(stateDir, snapshotTurns, processStartedAt - 1_000),
    );
    yield* continueOnce;
    assert.strictEqual(dispatched.length, 1);
  });
});

it.effect("a restart that is not an update continues nothing", () => {
  const { stateDir, paths, controller } = setup();
  const processStartedAt = Date.now();
  // The last update was yesterday; the daemon crashed today.
  const yesterday = processStartedAt - 24 * 60 * 60_000;
  writeFileSync(
    paths.statusFile,
    JSON.stringify({
      state: "done",
      startedAt: iso(yesterday),
      updatedAt: iso(yesterday),
      finishedAt: iso(yesterday),
    }),
  );
  const dispatched: OrchestrationCommand[] = [];
  const threads = [
    makeThread(
      "cut",
      { status: "error", activeTurnId: null },
      { turnId: TurnId.make("turn-cut"), state: "interrupted" },
    ),
  ];
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      writeTurnsSnapshot(stateDir, [{ threadId: "cut", turnId: "turn-cut" }], yesterday),
    );
    yield* continueTurnsAfterSelfUpdateWith({ stateDir, controller, processStartedAt }).pipe(
      provide({ threads, dispatched }),
    );
    assert.strictEqual(dispatched.length, 0);
    // A stale snapshot is dropped.
    assert.isNull(yield* Effect.promise(() => readTurnsSnapshot(stateDir)));
  });
});

it.effect("Update when they finish: waits for the agents, then asks the updater", () => {
  const { stateDir, paths, controller } = setup();
  const processStartedAt = Date.now() - 60 * 60_000;
  const tick = makeSelfUpdateWatcherTick({ stateDir, controller, processStartedAt });
  const working = [
    makeThread(
      "busy",
      { status: "running", activeTurnId: TurnId.make("turn-busy") },
      { turnId: TurnId.make("turn-busy"), state: "running" },
    ),
  ];
  const now = Date.now();
  return Effect.gen(function* () {
    yield* Effect.promise(() => writeDeferredUpdate(stateDir, deferredUpdateFor(now)));

    // An agent works: nothing happens.
    yield* tick(now).pipe(provide({ threads: working }));
    assert.isFalse(existsSync(paths.requestFile));

    // Done a moment ago: still waits (a manager starts its next turn right away).
    yield* tick(now + 5_000).pipe(provide({ threads: [] }));
    assert.isFalse(existsSync(paths.requestFile));

    // Nobody worked for a while: the update starts, the wait is over.
    yield* tick(now + 5_000 + DEFERRED_UPDATE_IDLE_MS).pipe(provide({ threads: [] }));
    assert.isTrue(existsSync(paths.requestFile));
    assert.isNull(yield* Effect.promise(() => readDeferredUpdate(stateDir)));
    // What was working is remembered for after the restart (nothing, here).
    assert.deepStrictEqual((yield* Effect.promise(() => readTurnsSnapshot(stateDir)))?.turns, []);

    // While the request waits for the updater the snapshot follows the agents.
    yield* tick(now + 20_000).pipe(provide({ threads: working }));
    assert.deepStrictEqual((yield* Effect.promise(() => readTurnsSnapshot(stateDir)))?.turns, [
      { threadId: "busy", turnId: "turn-busy" },
    ]);
  });
});

it.effect("Update when they finish: half an hour later it updates anyway", () => {
  const { stateDir, paths, controller } = setup();
  const tick = makeSelfUpdateWatcherTick({
    stateDir,
    controller,
    processStartedAt: Date.now() - 60 * 60_000,
  });
  const now = Date.now();
  const working = [
    makeThread(
      "busy",
      { status: "running", activeTurnId: TurnId.make("turn-busy") },
      { turnId: TurnId.make("turn-busy"), state: "running" },
    ),
  ];
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      writeDeferredUpdate(stateDir, deferredUpdateFor(now - 31 * 60_000)),
    );
    yield* tick(now).pipe(provide({ threads: working }));
    assert.isTrue(existsSync(paths.requestFile));
    // The agent cut off by it will be continued after the restart.
    assert.deepStrictEqual((yield* Effect.promise(() => readTurnsSnapshot(stateDir)))?.turns, [
      { threadId: "busy", turnId: "turn-busy" },
    ]);
  });
});
