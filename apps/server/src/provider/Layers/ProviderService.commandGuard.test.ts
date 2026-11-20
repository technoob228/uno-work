/**
 * ProviderService and chats held to the rules of this computer (started at a
 * cloud chat's request, chatRequests/): the adapter gets the plan, a harness
 * that can't hold it is refused, and every other chat starts as before.
 */
import type {
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderAdapterStartSessionInput,
} from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  CommandGuardPolicy,
  harnessNotGuardableMessage,
  type CommandGuardPlan,
} from "../Services/CommandGuardPolicy.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const cursorInstance = ProviderInstanceId.make("cursor");
const thread = ThreadId.make("thread-guarded");

const PLAN: CommandGuardPlan = {
  why: "started at the request of a cloud chat",
  blockedRoots: ["/Users/m/.unowork/userdata", "/Users/m/.uno-work/chat-requests"],
};

function makeFakeAdapter(provider: ProviderDriverKind, commandGuard: boolean) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const startSession = vi.fn((input: ProviderAdapterStartSessionInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${input.threadId}` },
        cwd: input.cwd ?? "/",
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(input.threadId, session);
      return session;
    }),
  );
  const stopSession = vi.fn((threadId: ThreadId) =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      ...(commandGuard ? { commandGuard } : {}),
    },
    startSession,
    sendTurn: (input: ProviderSendTurnInput) =>
      sessions.has(input.threadId)
        ? Effect.succeed<ProviderTurnStartResult>({
            threadId: input.threadId,
            turnId: TurnId.make(`turn-${input.threadId}`),
          })
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider, threadId: input.threadId }),
          ),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () => Effect.sync(() => sessions.clear()),
    streamEvents: Stream.fromPubSub(events),
  };
  return { adapter, startSession, stopSession };
}

function setup(guarded: ReadonlySet<string> | null) {
  const claude = makeFakeAdapter(CLAUDE, true);
  const cursor = makeFakeAdapter(CURSOR, false);
  const registry = makeAdapterRegistryMock({ [CLAUDE]: claude.adapter, [CURSOR]: cursor.adapter });
  const runtimeRepository = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository));
  const base = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
    Layer.provide(directory),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );
  const layer =
    guarded === null
      ? base
      : base.pipe(
          Layer.provide(
            Layer.succeed(CommandGuardPolicy, {
              decide: ({ threadId }) => Effect.succeed(guarded.has(threadId) ? PLAN : null),
              isGuarded: (threadId) => Effect.succeed(guarded.has(threadId)),
            }),
          ),
        );
  return { claude, cursor, layer: Layer.mergeAll(layer, NodeServices.layer) };
}

const startOn = (instance: ProviderInstanceId, provider: ProviderDriverKind) =>
  Effect.gen(function* () {
    const service = yield* ProviderService;
    return yield* service.startSession(thread, {
      threadId: thread,
      provider,
      providerInstanceId: instance,
      cwd: "/Users/m/projects/shop",
      runtimeMode: "full-access",
    });
  });

it.effect("a chat started at a cloud chat's request hands the adapter its rules", () => {
  const { claude, layer } = setup(new Set([thread]));
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    const input = claude.startSession.mock.calls[0]![0];
    assert.deepStrictEqual(input.commandGuard, PLAN);
    // Its mode stays what it is: the rules hold in every mode.
    assert.equal(input.runtimeMode, "full-access");
  }).pipe(Effect.provide(layer));
});

it.effect("fails closed on a harness that can't hold it to the rules", () => {
  const { cursor, layer } = setup(new Set([thread]));
  return Effect.gen(function* () {
    const error = yield* Effect.flip(startOn(cursorInstance, CURSOR));
    assert.instanceOf(error, ProviderAdapterRequestError);
    assert.equal((error as ProviderAdapterRequestError).detail, harnessNotGuardableMessage(CURSOR));
    assert.equal(cursor.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("every other chat starts as before, on any harness", () => {
  const { claude, cursor, layer } = setup(new Set(["another-thread"]));
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.equal("commandGuard" in claude.startSession.mock.calls[0]![0], false);
    yield* startOn(cursorInstance, CURSOR);
    assert.equal(cursor.startSession.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("without the policy nothing is held", () => {
  const { claude, layer } = setup(null);
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.equal("commandGuard" in claude.startSession.mock.calls[0]![0], false);
  }).pipe(Effect.provide(layer));
});
