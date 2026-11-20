/**
 * GeminiAdapter end to end against a stand-in for `gemini --acp`
 * (testUtils/fakeGeminiAcpAgent.mjs, spawned for real): Uno Work keeps the
 * session in Gemini's `default` mode whatever the person's settings start it
 * in (every edit and command comes back for an answer), Plan goes to Gemini's
 * `plan`, the uno-work MCP tools are answered without asking, other tools ask
 * in Ask mode — and a chat refuses to start when the Google sign-in it would
 * wait for is missing.
 */
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";

import {
  GeminiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { type GeminiAdapterShape, makeGeminiAdapter } from "./GeminiAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.resolve(__dirname, "../testUtils/fakeGeminiAcpAgent.mjs");
const instanceId = ProviderInstanceId.make("gemini");
const PROVIDER = ProviderDriverKind.make("gemini");

/** A `gemini` on PATH (the fake) and a ~/.gemini with the given settings. */
const makeMachine = (settings: unknown) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uno-gemini-adapter-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await copyFile(fakeAgent, path.join(bin, "gemini"));
    await chmod(path.join(bin, "gemini"), 0o755);
    await mkdir(path.join(root, ".gemini"));
    await writeFile(path.join(root, ".gemini", "settings.json"), JSON.stringify(settings));
    return {
      root,
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        GEMINI_CLI_HOME: root,
      },
    };
  });

const withAdapter = <A, E>(
  env: NodeJS.ProcessEnv,
  use: (adapter: GeminiAdapterShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeGeminiAdapter(Schema.decodeSync(GeminiSettings)({}), {
      instanceId,
      displayName: "Gemini CLI",
      environment: env,
    });
    return yield* use(adapter);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-gemini-adapter-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const runTurn = (
  adapter: GeminiAdapterShape,
  threadId: ThreadId,
  input: string,
  options: {
    readonly interactionMode?: "default" | "plan";
    readonly answer?: "accept" | "decline";
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* adapter.streamEvents.pipe(
      Stream.filter((event: ProviderRuntimeEvent) => event.threadId === threadId),
      Stream.tap((event) =>
        event.type === "request.opened" && options.answer
          ? adapter.respondToRequest(threadId, event.requestId as never, options.answer)
          : Effect.void,
      ),
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({
      threadId,
      input,
      attachments: [],
      ...(options.interactionMode ? { interactionMode: options.interactionMode } : {}),
    });
    const collected = Array.from(yield* Fiber.join(events));
    const text = collected
      .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
      .join("");
    return {
      text,
      asked: collected.filter((event) => event.type === "request.opened").length,
    };
  });

const start = (adapter: GeminiAdapterShape, threadId: ThreadId, runtimeMode: RuntimeMode) =>
  adapter.startSession({
    threadId,
    provider: PROVIDER,
    cwd: process.cwd(),
    runtimeMode,
    modelSelection: { instanceId, model: "auto" },
  });

const API_KEY_SETTINGS = { security: { auth: { selectedType: "gemini-api-key" } } };

it.effect("a session the person's settings start in yolo runs in default; Plan runs in plan", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine(API_KEY_SETTINGS);
    const env = { ...machine.env, GEMINI_API_KEY: "test-key", FAKE_GEMINI_START_MODE: "yolo" };
    yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("gemini-modes");
        const session = yield* start(adapter, threadId, "approval-required");
        assert.equal(session.provider, "gemini");
        const first = yield* runTurn(adapter, threadId, "hello");
        assert.equal(first.text, "mode=default model=auto set_mode=default");
        const plan = yield* runTurn(adapter, threadId, "think first", { interactionMode: "plan" });
        assert.equal(plan.text, "mode=plan model=auto set_mode=default,plan");
        const back = yield* runTurn(adapter, threadId, "now do it", {
          interactionMode: "default",
        });
        assert.equal(back.text, "mode=default model=auto set_mode=default,plan,default");
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("Ask mode: uno-work tools go through, a shell command asks the person", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine(API_KEY_SETTINGS);
    const env = { ...machine.env, GEMINI_API_KEY: "test-key" };
    yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("gemini-approvals");
        yield* start(adapter, threadId, "approval-required");
        const mcp = yield* runTurn(adapter, threadId, "DO_MCP");
        assert.equal(mcp.asked, 0);
        assert.match(mcp.text, /^mcp allowed; /);
        const declined = yield* runTurn(adapter, threadId, "DO_SHELL", { answer: "decline" });
        assert.equal(declined.asked, 1);
        assert.match(declined.text, /^shell denied; /);
        const accepted = yield* runTurn(adapter, threadId, "DO_SHELL", { answer: "accept" });
        assert.equal(accepted.asked, 1);
        assert.match(accepted.text, /^shell allowed; /);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("Full access answers the shell prompt itself", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine(API_KEY_SETTINGS);
    const env = { ...machine.env, GEMINI_API_KEY: "test-key" };
    yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("gemini-full-access");
        yield* start(adapter, threadId, "full-access");
        const turn = yield* runTurn(adapter, threadId, "DO_SHELL");
        assert.equal(turn.asked, 0);
        assert.match(turn.text, /^shell allowed; mode=default/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("a refused API key comes back as a failed turn with Google's own words", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine(API_KEY_SETTINGS);
    const env = { ...machine.env, GEMINI_API_KEY: "test-key" };
    yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("gemini-api-error");
        yield* start(adapter, threadId, "approval-required");
        const sent = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "DO_API_ERROR", attachments: [] }),
        );
        assert.ok(Exit.isFailure(sent));
        const failure = Cause.findErrorOption(sent.cause);
        assert.ok(Option.isSome(failure), Cause.pretty(sent.cause));
        assert.match(
          String(failure.value.message),
          /API key not valid\. Please pass a valid API key\./,
        );
        assert.notMatch(String(failure.value.message), /\{"error"/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("refuses to start when the Google sign-in it would wait for is missing", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ security: { auth: { selectedType: "oauth-personal" } } });
    yield* withAdapter(machine.env, (adapter) =>
      Effect.gen(function* () {
        const exit = yield* start(adapter, ThreadId.make("gemini-no-login"), "full-access").pipe(
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /not signed in to Google/);
      }),
    );
  }),
);
