/**
 * ProviderService and the assistant sandbox: which sessions get a sandbox
 * plan, which are refused (fail closed), and that everything else starts
 * exactly as before.
 */
import type {
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  RuntimeMode,
} from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { HarnessSandboxPlan } from "../../sandbox/harnessSandbox.ts";
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
  HarnessSandboxPolicy,
  type HarnessSandboxDecision,
} from "../Services/HarnessSandboxPolicy.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { harnessNotSandboxableMessage, makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const cursorInstance = ProviderInstanceId.make("cursor");
const thread = ThreadId.make("thread-sandbox");

const PLAN: HarnessSandboxPlan = {
  bwrapPath: "/usr/bin/bwrap",
  home: "/home/unowork",
  cwd: "/home/unowork/projects/shop",
  writableDirs: ["/home/unowork/UnoWork/Assistants/ana", "/home/unowork/projects/shop"],
  hiddenDirs: [],
  tmpDir: "/var/lib/uno-work/userdata/sandbox/tmp/assistant-ana",
  assistantProjectId: "assistant-ana",
};

function makeFakeAdapter(provider: ProviderDriverKind, harnessSandbox: boolean) {
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
      ...(harnessSandbox ? { harnessSandbox } : {}),
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

function setup(policy: { current: HarnessSandboxDecision; ceiling?: RuntimeMode | null } | null) {
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
    policy === null
      ? base
      : base.pipe(
          Layer.provide(
            Layer.succeed(HarnessSandboxPolicy, {
              decide: () => Effect.sync(() => policy.current),
              runtimeCeiling: () => Effect.sync(() => policy.ceiling ?? null),
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
      cwd: PLAN.cwd,
      runtimeMode: "full-access",
    });
  });

const sendTurn = Effect.gen(function* () {
  const service = yield* ProviderService;
  return yield* service.sendTurn({ threadId: thread, input: "hi", attachments: [] });
});

it.effect("an Asks-first assistant's chat runs at its ceiling, whatever the request asked", () => {
  const { claude, layer } = setup({ current: { _tag: "none" }, ceiling: "auto-accept-edits" });
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.equal(claude.startSession.mock.calls[0]![0].runtimeMode, "auto-accept-edits");
  }).pipe(Effect.provide(layer));
});

it.effect("no ceiling (the person's chat, Autonomous): the requested mode stands", () => {
  const { claude, layer } = setup({ current: { _tag: "none" }, ceiling: null });
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.equal(claude.startSession.mock.calls[0]![0].runtimeMode, "full-access");
  }).pipe(Effect.provide(layer));
});

it.effect("without a policy every session starts as before (no sandbox)", () => {
  const { claude, layer } = setup(null);
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    const input = claude.startSession.mock.calls[0]![0];
    assert.equal("harnessSandbox" in input, false);
  }).pipe(Effect.provide(layer));
});

it.effect("an All-projects assistant or the person's chat (none) starts without bwrap", () => {
  const { claude, cursor, layer } = setup({ current: { _tag: "none" } });
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.equal("harnessSandbox" in claude.startSession.mock.calls[0]![0], false);
    // A harness that can't be sandboxed still runs normal chats.
    yield* startOn(cursorInstance, CURSOR);
    assert.equal(cursor.startSession.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a restricted assistant's chat hands the adapter its sandbox plan", () => {
  const { claude, layer } = setup({ current: { _tag: "sandbox", plan: PLAN } });
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    assert.deepStrictEqual(claude.startSession.mock.calls[0]![0].harnessSandbox, PLAN);
  }).pipe(Effect.provide(layer));
});

it.effect("fails closed on a harness that can't run in the sandbox", () => {
  const { cursor, layer } = setup({ current: { _tag: "sandbox", plan: PLAN } });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(startOn(cursorInstance, CURSOR));
    assert.instanceOf(error, ProviderAdapterRequestError);
    assert.equal(
      (error as ProviderAdapterRequestError).detail,
      harnessNotSandboxableMessage(CURSOR),
    );
    assert.equal(cursor.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("fails closed where the sandbox can't run (refuse): nothing starts", () => {
  const { claude, layer } = setup({
    current: { _tag: "refuse", message: "Needs a cloud computer." },
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(startOn(claudeInstance, CLAUDE));
    assert.instanceOf(error, ProviderAdapterRequestError);
    assert.equal((error as ProviderAdapterRequestError).detail, "Needs a cloud computer.");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("narrowing an assistant mid-chat restarts the live session in the sandbox", () => {
  const policy: { current: HarnessSandboxDecision } = { current: { _tag: "none" } };
  const { claude, layer } = setup(policy);
  return Effect.gen(function* () {
    yield* startOn(claudeInstance, CLAUDE);
    yield* sendTurn;
    assert.equal(claude.startSession.mock.calls.length, 1);

    policy.current = { _tag: "sandbox", plan: PLAN };
    yield* sendTurn;
    assert.equal(claude.stopSession.mock.calls.length, 1);
    assert.equal(claude.startSession.mock.calls.length, 2);
    const resumed = claude.startSession.mock.calls[1]![0];
    assert.deepStrictEqual(resumed.harnessSandbox, PLAN);
    assert.deepStrictEqual(resumed.resumeCursor, { opaque: `resume-${thread}` });

    // Same decision: no more restarts.
    yield* sendTurn;
    assert.equal(claude.startSession.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a live session whose assistant can no longer run is stopped and the turn refused",
  () => {
    const policy: { current: HarnessSandboxDecision } = {
      current: { _tag: "sandbox", plan: PLAN },
    };
    const { claude, layer } = setup(policy);
    return Effect.gen(function* () {
      yield* startOn(claudeInstance, CLAUDE);
      policy.current = { _tag: "refuse", message: "No sandbox here." };
      const error = yield* Effect.flip(sendTurn);
      assert.instanceOf(error, ProviderAdapterRequestError);
      assert.equal(claude.stopSession.mock.calls.length, 1);
      assert.equal(claude.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  },
);
