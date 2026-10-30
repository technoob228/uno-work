import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach } from "vitest";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  OPENCODE_DECLINED_FEEDBACK,
  OPENCODE_STALL_RETRY_PROMPT,
  appendOpenCodeAssistantTextDelta,
  isOpenCodeStreamStall,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  visibleUnoAssistantTextFromRaw,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    /** Delay before the subscribed events arrive (lets a test start a turn first). */
    subscribeDelayMs: 0,
    connectEnvironments: [] as Array<NodeJS.ProcessEnv | undefined>,
    permissionReplies: [] as Array<{ requestID: string; reply: string; message?: string }>,
    questionReplies: [] as Array<{ requestID: string; answers: unknown }>,
    sessionParents: {} as Record<string, string | undefined>,
    sessionGetCalls: [] as string[],
    /**
     * Per-subscribe scripts. When null, the first subscription yields
     * `subscribedEvents` and then stays open (like a live SSE stream) until
     * aborted; later subscriptions stay open with no events.
     */
    subscriptionScripts: null as Array<{
      readonly events: unknown[];
      readonly end: "close" | "hang";
      /** Events are only yielded once this resolves. */
      readonly gate?: Promise<void>;
    }> | null,
    subscribeCount: 0,
    sessionStatuses: {} as Record<string, { type: string }>,
    sessionStatusCalls: 0,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.subscribeDelayMs = 0;
    this.state.connectEnvironments.length = 0;
    this.state.permissionReplies = [];
    this.state.questionReplies = [];
    this.state.sessionParents = {};
    this.state.sessionGetCalls = [];
    this.state.subscriptionScripts = null;
    this.state.subscribeCount = 0;
    this.state.sessionStatuses = {};
    this.state.sessionStatusCalls = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, environment }) =>
    Effect.gen(function* () {
      runtimeMock.state.connectEnvironments.push(environment);
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Unconditionally register a scope finalizer for test observability —
      // preserves the `closeCalls` / `closeError` probes that the existing
      // suites rely on. Production code never attaches a finalizer to an
      // external server (it simply returns `Effect.succeed(...)`).
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) => {
    // Subscriptions are counted per client (the event hub keeps one client
    // per stream) so sessions left running by earlier tests in the shared
    // layer can't consume a script.
    let clientSubscribeCount = 0;
    return {
      session: {
        create: async () => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
        },
        status: async () => {
          runtimeMock.state.sessionStatusCalls += 1;
          return { data: { ...runtimeMock.state.sessionStatuses } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetCalls.push(sessionID);
          if (!(sessionID in runtimeMock.state.sessionParents)) {
            throw new Error(`session not found: ${sessionID}`);
          }
          const parentID = runtimeMock.state.sessionParents[sessionID];
          return { data: { id: sessionID, ...(parentID ? { parentID } : {}) } };
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      permission: {
        reply: async (input: { requestID: string; reply: string; message?: string }) => {
          runtimeMock.state.permissionReplies.push(input);
          return { data: true };
        },
      },
      question: {
        reply: async (input: { requestID: string; answers: unknown }) => {
          runtimeMock.state.questionReplies.push(input);
          return { data: true };
        },
      },
      event: {
        subscribe: async (_parameters: unknown, options?: { signal?: AbortSignal }) => {
          const index = clientSubscribeCount;
          clientSubscribeCount += 1;
          runtimeMock.state.subscribeCount += 1;
          const scripts = runtimeMock.state.subscriptionScripts;
          const script = scripts
            ? (scripts[index] ?? { events: [], end: "hang" as const })
            : {
                events: index === 0 ? runtimeMock.state.subscribedEvents : [],
                end: "hang" as const,
              };
          const delay = index === 0 ? runtimeMock.state.subscribeDelayMs : 0;
          const signal = options?.signal;
          return {
            stream: (async function* () {
              if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
              if ("gate" in script && script.gate) {
                await script.gate;
              }
              for (const event of script.events) {
                yield event;
              }
              if (script.end === "hang" && signal && !signal.aborted) {
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true }),
                );
              }
            })(),
          };
        },
      },
    } as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>;
  },
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  Effect.gen(function* () {
    return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings);
  }),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "opencode");
      assert.equal(session.threadId, "thread-opencode");
      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      assert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      assert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        assert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(error.detail, "prompt failed");
      assert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
      assert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect(
    "clears active turn state when interrupting a turn without an OpenCode idle event",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-interrupt-without-idle");
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const { turnId } = yield* adapter.sendTurn({
          threadId,
          input: "Stop me",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });

        let sessions = yield* adapter.listSessions();
        let session = sessions.find((entry) => entry.threadId === threadId);
        assert.equal(session?.status, "running");
        assert.equal(session?.activeTurnId, turnId);

        yield* adapter.interruptTurn(threadId, turnId);
        sessions = yield* adapter.listSessions();
        session = sessions.find((entry) => entry.threadId === threadId);

        assert.equal(session?.status, "ready");
        assert.equal(session?.activeTurnId, undefined);
        assert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
        assert.deepEqual(
          events.map((event) => event.type),
          ["session.started", "thread.started", "turn.started", "turn.aborted"],
        );
      }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  const stallTestLayer = () =>
    Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings);
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
  const stallSessionId = "http://127.0.0.1:9999/session";
  const stallEvent = {
    type: "session.error",
    properties: {
      sessionID: stallSessionId,
      error: { name: "UnknownError", data: { message: "SSE read timed out" } },
    },
  };
  const idleEvent = {
    type: "session.status",
    properties: { sessionID: stallSessionId, status: { type: "idle" } },
  };
  const runStalledTurn = (threadId: string, events: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      runtimeMock.state.subscribeDelayMs = 40;
      runtimeMock.state.subscribedEvents = [...events];
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId(threadId),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: asThreadId(threadId),
        input: "Do it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/claude-sonnet-4-5",
        ),
      });
      yield* sleep(300);
      const sessions = yield* adapter.listSessions();
      return sessions.find((entry) => entry.threadId === threadId);
    }).pipe(Effect.provide(stallTestLayer()));

  it.effect("continues a turn whose model stream stalled, with the same model", () =>
    Effect.gen(function* () {
      const session = yield* runStalledTurn("thread-stall", [stallEvent, idleEvent]);

      assert.equal(runtimeMock.state.promptCalls.length, 2);
      assert.deepEqual(runtimeMock.state.promptCalls[1], {
        sessionID: stallSessionId,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        parts: [{ type: "text", text: OPENCODE_STALL_RETRY_PROMPT }],
      });
      // The idle of the stalled run did not close the turn the retry continues.
      assert.equal(session?.status, "running");
      assert.notEqual(session?.activeTurnId, undefined);
    }),
  );

  it.effect("fails the turn when its stream stalls a second time", () =>
    Effect.gen(function* () {
      const session = yield* runStalledTurn("thread-stall-twice", [stallEvent, stallEvent]);

      assert.equal(runtimeMock.state.promptCalls.length, 1);
      assert.equal(session?.status, "error");
      assert.equal(session?.activeTurnId, undefined);
    }),
  );

  it("recognizes opencode's stream timeouts as stalls", () => {
    assert.equal(isOpenCodeStreamStall("SSE read timed out"), true);
    assert.equal(isOpenCodeStreamStall("Provider response headers timed out after 120000ms"), true);
    assert.equal(isOpenCodeStreamStall("Insufficient balance"), false);
  });

  it.effect("sends Uno Kimi turns without the final-answer marker instruction", () => {
    const unoInstanceId = ProviderInstanceId.make("uno");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: unoInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-uno-kimi-marker");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Проверь статус",
        modelSelection: createModelSelection(unoInstanceId, "uno/moonshotai/kimi-k2.6"),
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "uno",
          modelID: "moonshotai/kimi-k2.6",
        },
        parts: [
          {
            type: "text",
            text: "Проверь статус",
          },
        ],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("keeps the final-answer marker instruction for Uno Gemini 3 turns", () => {
    const unoInstanceId = ProviderInstanceId.make("uno");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: unoInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-uno-gemini-marker");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Проверь статус",
        modelSelection: createModelSelection(unoInstanceId, "uno/google/gemini-3.1-pro-preview"),
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "uno",
          modelID: "google/gemini-3.1-pro-preview",
        },
        parts: [
          {
            type: "text",
            text: [
              "For this turn, do not include internal reasoning in the user-visible answer.",
              "Begin the final user-visible answer with <uno_final_answer> on its own line.",
              "Do not write anything user-visible before that marker.",
              "",
              "Проверь статус",
            ].join("\n"),
          },
        ],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("routes Uno image-generation models outside OpenCode promptAsync", () => {
    const unoInstanceId = ProviderInstanceId.make("uno");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: unoInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("uno"),
        threadId: asThreadId("thread-uno-image-generation"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-uno-image-generation"),
        input: "сделай картинку буэнос айреса район палермо летом",
        modelSelection: createModelSelection(unoInstanceId, "uno/openai/gpt-image-1"),
      });
      yield* sleep(10);

      assert.equal(runtimeMock.state.promptCalls.length, 0);
      const [session] = yield* adapter.listSessions();
      assert.equal(session?.lastError, "Uno API key is missing.");
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      assert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      assert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      assert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      assert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("appends assistant text deltas verbatim, keeping doubled letters and digits", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Посмотрю ком");
      const letters = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "мит, лимит 120 0");
      const digits = appendOpenCodeAssistantTextDelta(letters.nextText, "00 токенов");
      const finalUpdate = mergeOpenCodeAssistantText(
        digits.nextText,
        "Посмотрю коммит, лимит 120 000 токенов.",
      );

      assert.deepEqual(
        [letters.deltaToEmit, digits.deltaToEmit, finalUpdate.deltaToEmit],
        ["мит, лимит 120 0", "00 токенов", "."],
      );
      assert.equal(finalUpdate.latestText, "Посмотрю коммит, лимит 120 000 токенов.");
    }),
  );

  it.effect(
    "extracts visible Uno answers after the final-answer marker or Kimi-style preamble",
    () =>
      Effect.sync(() => {
        assert.equal(
          visibleUnoAssistantTextFromRaw(
            [
              "The user is asking for an update. I should answer directly.",
              "<uno_final_answer>",
              "Понял, проверяю.",
            ].join("\n"),
          ),
          "Понял, проверяю.",
        );

        assert.equal(
          visibleUnoAssistantTextFromRaw(
            "The user is reacting to my previous answer. I should clarify. Use bash tool with loops.Понял, давай проверим.",
          ),
          "Понял, давай проверим.",
        );

        // Kimi/DeepSeek echo a closing tag after the answer; it must not leak.
        assert.equal(
          visibleUnoAssistantTextFromRaw("<uno_final_answer>\nParis </uno_final_answer>"),
          "Paris",
        );
        assert.equal(
          visibleUnoAssistantTextFromRaw("<uno_final_answer>\nParis </uno_final"),
          "Paris",
        );
        assert.equal(visibleUnoAssistantTextFromRaw("<uno_final_answer>\na < b"), "a < b");
        // Kimi K2.7 (0.0.82): the marker repeated inside the answer, or with odd spacing.
        assert.equal(
          visibleUnoAssistantTextFromRaw(
            "thinking…<uno_final_answer>\n<uno_final_answer>\nParis\n< /uno_final_answer >",
          ),
          "Paris",
        );
      }),
  );

  it.effect("shows auto-compaction as a notice instead of the summary text", () =>
    Effect.gen(function* () {
      const sessionID = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id: "msg-summary", role: "assistant", mode: "compaction", summary: true },
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID,
            messageID: "msg-summary",
            partID: "part-summary",
            field: "text",
            delta: "## Objective\n- internal notes",
          },
        },
        {
          type: "message.updated",
          properties: { sessionID, info: { id: "msg-answer", role: "assistant", mode: "build" } },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID,
            messageID: "msg-answer",
            partID: "part-answer",
            field: "text",
            delta: "Готово",
          },
        },
      ];
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-compaction-notice");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "content.delta" || event.type === "thread.state.changed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.deepEqual(
        events.map((event) =>
          event.type === "content.delta" ? `delta:${event.payload.delta}` : event.type,
        ),
        ["thread.state.changed", "delta:Готово"],
      );
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        Effect.gen(function* () {
          return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
            nativeEventLogger,
          });
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(session.threadId, "thread-native-log");
      assert.equal(nativeEvents.length, 1);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      assert.deepEqual(closeCallsDuringRun, []);
    }),
  );
  it.effect(
    "merges an assistant workspace's .mcp.json servers into a spawned server config",
    () => {
      const workspace = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-mcp-"));
      // The marker AssistantService writes: only an assistant's own workspace
      // gets its .mcp.json servers.
      nodeFs.writeFileSync(nodePath.join(workspace, ".uno-assistant.json"), "{}\n");
      nodeFs.writeFileSync(
        nodePath.join(workspace, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "uno-manager": {
              type: "http",
              url: "http://127.0.0.1:13776/api/manager/mcp",
              headers: { Authorization: "Bearer uwm_test" },
            },
          },
        }),
      );
      const spawnedSettings = Schema.decodeSync(OpenCodeSettings)({ binaryPath: "fake-opencode" });
      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(spawnedSettings, {
          environment: {
            PATH: "/usr/bin",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["/tmp/browser.md"] }),
          },
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-assistant-mcp"),
          cwd: workspace,
          runtimeMode: "full-access",
        });

        const environment = runtimeMock.state.connectEnvironments.at(-1);
        assert.equal(environment?.PATH, "/usr/bin");
        assert.deepEqual(JSON.parse(environment?.OPENCODE_CONFIG_CONTENT ?? "{}"), {
          instructions: ["/tmp/browser.md"],
          mcp: {
            "uno-manager": {
              type: "remote",
              url: "http://127.0.0.1:13776/api/manager/mcp",
              headers: { Authorization: "Bearer uwm_test" },
              enabled: true,
            },
          },
        });
      }).pipe(
        Effect.provide(adapterLayer),
        Effect.ensuring(
          Effect.sync(() => nodeFs.rmSync(workspace, { recursive: true, force: true })),
        ),
      );
    },
  );
  it.effect(
    "leaves an ordinary project's .mcp.json alone (a cloned repo must not start servers unasked)",
    () => {
      const workspace = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-mcp-"));
      nodeFs.writeFileSync(
        nodePath.join(workspace, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "uno-manager": {
              type: "http",
              url: "http://127.0.0.1:13776/api/manager/mcp",
              headers: { Authorization: "Bearer uwm_test" },
            },
          },
        }),
      );
      const spawnedSettings = Schema.decodeSync(OpenCodeSettings)({ binaryPath: "fake-opencode" });
      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(spawnedSettings, {
          environment: {
            PATH: "/usr/bin",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["/tmp/browser.md"] }),
          },
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-project-mcp"),
          cwd: workspace,
          runtimeMode: "full-access",
        });

        const environment = runtimeMock.state.connectEnvironments.at(-1);
        assert.equal(environment?.PATH, "/usr/bin");
        assert.deepEqual(JSON.parse(environment?.OPENCODE_CONFIG_CONTENT ?? "{}"), {
          instructions: ["/tmp/browser.md"],
        });
      }).pipe(
        Effect.provide(adapterLayer),
        Effect.ensuring(
          Effect.sync(() => nodeFs.rmSync(workspace, { recursive: true, force: true })),
        ),
      );
    },
  );
  it.effect("surfaces non-command permissions as approvals with a readable title", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "perm-webfetch",
            sessionID: "http://127.0.0.1:9999/session",
            permission: "webfetch",
            patterns: ["https://example.com/docs"],
            metadata: {},
            always: [],
          },
        },
      ];
      const adapter = yield* OpenCodeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-generic-approval"),
        runtimeMode: "approval-required",
      });
      const [opened] = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        assert.equal(opened.requestId, "perm-webfetch");
        assert.equal(opened.payload.requestType, "unknown");
        assert.equal(opened.payload.detail, "Open a web page: https://example.com/docs");
      }
      assert.deepEqual(runtimeMock.state.permissionReplies, []);
    }),
  );

  it.effect("auto-approves permission requests in full-access mode", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "perm-doom-loop",
            sessionID: "http://127.0.0.1:9999/session",
            permission: "doom_loop",
            patterns: ["*"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "permission.replied",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            requestID: "perm-doom-loop",
            reply: "once",
          },
        },
      ];
      const adapter = yield* OpenCodeAdapter;
      const seen: string[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event.type))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-full-access-approval"),
        runtimeMode: "full-access",
      });
      yield* sleep(20);
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "perm-doom-loop", reply: "once" },
      ]);
      assert.equal(seen.includes("request.opened"), false);
      assert.equal(seen.includes("request.resolved"), false);
    }),
  );

  it.effect("routes subagent (child session) approvals into the main thread", () =>
    Effect.gen(function* () {
      const mainSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.created",
          properties: {
            sessionID: "child-1",
            info: { id: "child-1", parentID: mainSessionId },
          },
        },
        {
          type: "session.created",
          properties: {
            sessionID: "grandchild-1",
            info: { id: "grandchild-1", parentID: "child-1" },
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "perm-other-thread",
            sessionID: "foreign-session",
            permission: "bash",
            patterns: ["rm -rf /"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "perm-grandchild",
            sessionID: "grandchild-1",
            permission: "external_directory",
            patterns: ["/etc/*"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "child-1",
            info: { id: "child-msg", role: "assistant" },
          },
        },
      ];
      runtimeMock.state.sessionParents = { "foreign-session": undefined };
      const adapter = yield* OpenCodeAdapter;
      const opened: string[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "request.opened" && event.requestId) {
              opened.push(event.requestId);
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-child-approval"),
        runtimeMode: "approval-required",
      });
      yield* sleep(20);
      assert.deepEqual(opened, ["perm-grandchild"]);
      assert.deepEqual(runtimeMock.state.sessionGetCalls, ["foreign-session"]);

      yield* adapter.respondToRequest(
        asThreadId("thread-child-approval"),
        ApprovalRequestId.make("perm-grandchild"),
        "accept",
      );
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "perm-grandchild", reply: "once" },
      ]);
    }),
  );

  it.effect("a Decline tells the agent to say so, a Cancel just stops", () =>
    Effect.gen(function* () {
      const asked = (id: string) => ({
        type: "permission.asked",
        properties: {
          id,
          sessionID: "http://127.0.0.1:9999/session",
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
        },
      });
      runtimeMock.state.subscribedEvents = [asked("perm-declined"), asked("perm-cancelled")];
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-decline");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* sleep(20);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("perm-declined"), "decline");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("perm-cancelled"), "cancel");
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "perm-declined", reply: "reject", message: OPENCODE_DECLINED_FEEDBACK },
        { requestID: "perm-cancelled", reply: "reject" },
      ]);
    }),
  );

  it.effect("resolves missed child sessions via the parent chain and auto-approves them", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "perm-missed-child",
            sessionID: "missed-child",
            permission: "read",
            patterns: ["/repo/.env"],
            metadata: {},
            always: [],
          },
        },
      ];
      runtimeMock.state.sessionParents = {
        "missed-child": "http://127.0.0.1:9999/session",
      };
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-missed-child"),
        runtimeMode: "full-access",
      });
      yield* sleep(20);
      assert.deepEqual(runtimeMock.state.sessionGetCalls, ["missed-child"]);
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "perm-missed-child", reply: "once" },
      ]);
    }),
  );
  it.effect("resubscribes after a clean stream end and completes a turn that went idle", () =>
    Effect.gen(function* () {
      const mainSessionId = "http://127.0.0.1:9999/session";
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      runtimeMock.state.subscriptionScripts = [
        {
          gate,
          events: [
            { type: "server.connected", properties: {} },
            {
              type: "session.status",
              properties: { sessionID: mainSessionId, status: { type: "busy" } },
            },
          ],
          // OpenCode ends `/event` cleanly on instance dispose; the idle
          // status that follows is published while we are disconnected.
          end: "close",
        },
        { events: [{ type: "server.connected", properties: {} }], end: "hang" },
      ];
      runtimeMock.state.sessionStatuses = {};
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stream-reconnect");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed" && event.threadId === threadId),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const { turnId } = yield* adapter.sendTurn({
        threadId,
        input: "Do the thing",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      release();
      // Let the first subscription drain, then advance past the reconnect
      // backoff (Effect.sleep runs on the TestClock under it.effect).
      yield* sleep(20);
      yield* TestClock.adjust("1 second");
      yield* sleep(20);

      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.turnId, turnId);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }
      assert.equal(runtimeMock.state.subscribeCount, 2);
      assert.equal(runtimeMock.state.sessionStatusCalls >= 1, true);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
    }),
  );

  it.effect("keeps the active turn when OpenCode still reports busy after a reconnect", () =>
    Effect.gen(function* () {
      const mainSessionId = "http://127.0.0.1:9999/session";
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      runtimeMock.state.subscriptionScripts = [
        {
          gate,
          events: [
            { type: "server.connected", properties: {} },
            {
              type: "session.status",
              properties: { sessionID: mainSessionId, status: { type: "busy" } },
            },
          ],
          end: "close",
        },
        { events: [{ type: "server.connected", properties: {} }], end: "hang" },
      ];
      runtimeMock.state.sessionStatuses = { [mainSessionId]: { type: "busy" } };
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stream-reconnect-busy");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const { turnId } = yield* adapter.sendTurn({
        threadId,
        input: "Long task",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      release();
      yield* sleep(20);
      yield* TestClock.adjust("1 second");
      yield* sleep(20);

      assert.equal(runtimeMock.state.subscribeCount, 2);
      assert.equal(runtimeMock.state.sessionStatusCalls >= 1, true);
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "running");
      assert.equal(session?.activeTurnId, turnId);
    }),
  );

  it.effect("resubscribes when the event stream goes silent past the liveness window", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscriptionScripts = [
        // Connected, then nothing — not even heartbeats.
        { events: [{ type: "server.connected", properties: {} }], end: "hang" },
        { events: [{ type: "server.connected", properties: {} }], end: "hang" },
      ];
      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, { eventStreamIdleTimeoutMs: 60 }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const result = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-stream-silent"),
          runtimeMode: "full-access",
        });
        yield* sleep(20);
        // Past the 60 ms liveness window (watchdog ticks every 20 ms), then
        // past the reconnect backoff.
        yield* TestClock.adjust("100 millis");
        yield* sleep(20);
        yield* TestClock.adjust("1 second");
        yield* sleep(20);
        return {
          subscribeCount: runtimeMock.state.subscribeCount,
          sessions: yield* adapter.listSessions(),
        };
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(result.subscribeCount >= 2, true);
      assert.equal(result.sessions.length, 1);
    }),
  );
});
