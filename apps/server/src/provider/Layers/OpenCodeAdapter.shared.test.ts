import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OPENCODE_SESSION_ENV_DIR_ENV } from "../opencodeSessionEnv.ts";
import { makeOpenCodeAdapter, readOpenCodeResumeCursor } from "./OpenCodeAdapter.ts";

class SharedAdapter extends Context.Service<SharedAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeSharedAdapter",
) {}

interface FakeServer {
  readonly url: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: Deferred.Deferred<number>;
  closed: boolean;
}

const fake = {
  servers: [] as FakeServer[],
  sessions: new Map<string, { directory: string; permission?: unknown }>(),
  creates: 0,
  gets: [] as string[],
  updates: [] as Array<{ sessionID: string; permission?: unknown }>,
  subscriptions: 0,
  reset() {
    this.servers = [];
    this.sessions.clear();
    this.creates = 0;
    this.gets = [];
    this.updates = [];
    this.subscriptions = 0;
  },
};

const neverEndingStream = (signal: AbortSignal | undefined) =>
  (async function* () {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield* [];
  })();

const runtimeDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ environment }) =>
    Effect.gen(function* () {
      const server: FakeServer = {
        url: `http://127.0.0.1:${4400 + fake.servers.length}`,
        env: { ...environment },
        exit: yield* Deferred.make<number>(),
        closed: false,
      };
      fake.servers.push(server);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.closed = true;
        }),
      );
      return { url: server.url, exitCode: Deferred.await(server.exit) };
    }),
  connectToOpenCodeServer: () => Effect.die(new Error("per-session servers are not expected here")),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ directory }) =>
    ({
      session: {
        create: async ({ permission }: { permission?: unknown }) => {
          fake.creates += 1;
          const id = `ses_${fake.creates}`;
          fake.sessions.set(id, { directory, permission });
          return { data: { id } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          fake.gets.push(sessionID);
          if (!fake.sessions.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`);
          }
          return { data: { id: sessionID } };
        },
        update: async (input: { sessionID: string; permission?: unknown }) => {
          fake.updates.push(input);
          return { data: { id: input.sessionID } };
        },
        abort: async () => undefined,
      },
      global: {
        event: async ({ signal }: { signal?: AbortSignal } = {}) => {
          fake.subscriptions += 1;
          return { stream: neverEndingStream(signal) };
        },
      },
      event: {
        subscribe: async (_: unknown, { signal }: { signal?: AbortSignal } = {}) => {
          fake.subscriptions += 1;
          return { stream: neverEndingStream(signal) };
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(new OpenCodeRuntimeError({ operation: "inventory", detail: "unused" })),
};

const settings = Schema.decodeSync(OpenCodeSettings)({ binaryPath: "fake-uno-code" });

const APP_THREAD = "thread-app";

const makeLayer = () =>
  Layer.effect(
    SharedAdapter,
    makeOpenCodeAdapter(settings, {
      environment: { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ a: 1 }) },
      bridgeEnvironment: ({ threadId }) => ({
        UNO_BROWSER_BRIDGE_URL: "http://127.0.0.1:1",
        UNO_BROWSER_BRIDGE_TOKEN: `token-${threadId}`,
        ...(threadId === APP_THREAD
          ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ a: 1, label: "app" }) }
          : {}),
      }),
      eventSource: "global",
      shareServer: true,
      sharedServerLingerMs: 0,
    }),
  ).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, runtimeDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "opencode-shared-" })),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("unused")),
        getBinding: () => Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const start = (adapter: OpenCodeAdapterShape, threadId: string, resumeCursor?: unknown) =>
  adapter.startSession({
    provider: ProviderDriverKind.make("opencode"),
    threadId: ThreadId.make(threadId),
    cwd: process.cwd(),
    runtimeMode: "approval-required",
    ...(resumeCursor !== undefined ? { resumeCursor } : {}),
  });

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const envFileOf = (server: FakeServer, sessionId: string) =>
  path.join(server.env[OPENCODE_SESSION_ENV_DIR_ENV] ?? "", `${sessionId}.json`);

it.effect("threads of one instance share a server; per-thread tokens go to env files", () =>
  Effect.gen(function* () {
    fake.reset();
    const adapter = yield* SharedAdapter;
    const one = yield* start(adapter, "thread-1");
    const two = yield* start(adapter, "thread-2");

    yield* sleep(10);
    assert.equal(fake.servers.length, 1, "one process for both threads");
    const [server] = fake.servers;
    assert.ok(server);
    assert.equal(fake.subscriptions, 1, "one event subscription for both threads");
    assert.equal(server.env.UNO_BROWSER_BRIDGE_TOKEN, undefined, "no thread token in the server");
    const config = JSON.parse(server.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      a?: number;
      plugin?: string[];
    };
    assert.equal(config.a, 1);
    assert.ok(config.plugin?.some((entry) => entry.endsWith("uno-work-session-env.mjs")));

    const cursorOne = readOpenCodeResumeCursor(one.resumeCursor);
    const cursorTwo = readOpenCodeResumeCursor(two.resumeCursor);
    assert.ok(cursorOne && cursorTwo);
    const fileOne = envFileOf(server, cursorOne.openCodeSessionId);
    const fileTwo = envFileOf(server, cursorTwo.openCodeSessionId);
    assert.equal(
      (JSON.parse(fs.readFileSync(fileOne, "utf8")) as Record<string, string>)
        .UNO_BROWSER_BRIDGE_TOKEN,
      "token-thread-1",
    );
    assert.equal(
      (JSON.parse(fs.readFileSync(fileTwo, "utf8")) as Record<string, string>)
        .UNO_BROWSER_BRIDGE_TOKEN,
      "token-thread-2",
    );
    assert.equal((fs.statSync(fileOne).mode & 0o777).toString(8), "600");

    yield* adapter.stopSession(ThreadId.make("thread-1"));
    assert.equal(server.closed, false, "still used by thread-2");
    assert.equal(fs.existsSync(fileOne), false);

    yield* adapter.stopSession(ThreadId.make("thread-2"));
    assert.equal(server.closed, true, "last session gone → process gone");
    assert.equal(fs.existsSync(fileTwo), false);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a thread with its own OpenCode config gets its own server", () =>
  Effect.gen(function* () {
    fake.reset();
    const adapter = yield* SharedAdapter;
    yield* start(adapter, "thread-1");
    yield* start(adapter, APP_THREAD);
    yield* start(adapter, "thread-3");
    assert.equal(fake.servers.length, 2);
    const appServer = fake.servers[1];
    assert.ok(appServer);
    assert.match(appServer.env.OPENCODE_CONFIG_CONTENT ?? "", /"label":"app"/);
    yield* adapter.stopAll();
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("resumes the same OpenCode session after the thread was stopped", () =>
  Effect.gen(function* () {
    fake.reset();
    const adapter = yield* SharedAdapter;
    const first = yield* start(adapter, "thread-1");
    yield* adapter.stopSession(ThreadId.make("thread-1"));
    assert.equal(fake.servers[0]?.closed, true);

    const resumed = yield* start(adapter, "thread-1", first.resumeCursor);
    assert.equal(fake.creates, 1, "no new OpenCode session");
    assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
    assert.equal(fake.gets.length, 1);
    assert.equal(fake.updates.length, 1, "permissions refreshed for the current runtime mode");
    assert.equal(fake.servers.length, 2, "a fresh server after the old one stopped");

    // A cursor from another directory (or a vanished session) starts over.
    yield* adapter.stopSession(ThreadId.make("thread-1"));
    const cursor = readOpenCodeResumeCursor(first.resumeCursor);
    assert.ok(cursor);
    yield* start(adapter, "thread-1", { ...cursor, directory: "/elsewhere" });
    assert.equal(fake.creates, 2);
    yield* adapter.stopSession(ThreadId.make("thread-1"));
    yield* start(adapter, "thread-1", { ...cursor, openCodeSessionId: "ses_gone" });
    assert.equal(fake.creates, 3);
    yield* adapter.stopAll();
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("an idle thread whose server died exits quietly and restarts on demand", () =>
  Effect.gen(function* () {
    fake.reset();
    const adapter = yield* SharedAdapter;
    const events: ProviderRuntimeEvent[] = [];
    const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)),
    ).pipe(Effect.forkChild);

    const session = yield* start(adapter, "thread-1");
    const server = fake.servers[0];
    assert.ok(server);
    yield* Deferred.succeed(server.exit, 137);
    yield* sleep(20);

    assert.equal(yield* adapter.hasSession(ThreadId.make("thread-1")), false);
    const exited = events.find((event) => event.type === "session.exited");
    assert.ok(exited && exited.type === "session.exited");
    assert.equal(exited.payload.recoverable, true);
    assert.equal(
      events.some((event) => event.type === "runtime.error"),
      false,
      "no error shown for an idle thread",
    );

    yield* start(adapter, "thread-1", session.resumeCursor);
    assert.equal(fake.servers.length, 2);
    assert.equal(fake.creates, 1, "same conversation");
    yield* Fiber.interrupt(collector);
    yield* adapter.stopAll();
  }).pipe(Effect.provide(makeLayer())),
);
