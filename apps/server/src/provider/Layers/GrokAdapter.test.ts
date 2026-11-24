/**
 * GrokAdapter end to end against a stand-in for `grok agent stdio`
 * (testUtils/fakeGrokAcpAgent.mjs, spawned for real): Grok runs in its
 * `default` permission mode as an "extension" client, authenticates with
 * the key or the stored sign-in, the uno-work MCP tools go through and a
 * shell command asks; a chat without a sign-in refuses to start (Grok would
 * wait forever); a refused key, a thought, a cancelled turn with a running
 * tool and a resumed session come out right.
 */
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";

import {
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { type AcpAgentProfile, makeAcpAgentAdapter } from "./AcpAgentAdapter.ts";
import { type GrokAdapterShape, grokProfile } from "./GrokAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.resolve(__dirname, "../testUtils/fakeGrokAcpAgent.mjs");
const instanceId = ProviderInstanceId.make("grok");
const PROVIDER = ProviderDriverKind.make("grok");
const settings = Schema.decodeSync(GrokSettings)({});

/** A `grok` on PATH (the fake) and a GROK_HOME, signed in or not. */
const makeMachine = (options: { readonly signedIn: boolean }) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uno-grok-adapter-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await copyFile(fakeAgent, path.join(bin, "grok"));
    await chmod(path.join(bin, "grok"), 0o755);
    const home = path.join(root, ".grok");
    await mkdir(home);
    if (options.signedIn) {
      await writeFile(
        path.join(home, "auth.json"),
        JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "test-token" } }),
      );
    }
    return {
      root,
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        GROK_HOME: home,
      } as NodeJS.ProcessEnv,
    };
  });

const withAdapter = <A, E>(
  env: NodeJS.ProcessEnv,
  use: (adapter: GrokAdapterShape) => Effect.Effect<A, E>,
  profile: Partial<AcpAgentProfile> = {},
) =>
  Effect.gen(function* () {
    const adapter = yield* makeAcpAgentAdapter(
      { ...grokProfile(settings), ...profile },
      { instanceId, displayName: "Grok", environment: env },
    );
    return yield* use(adapter);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-grok-adapter-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const collectTurn = <E>(
  adapter: GrokAdapterShape,
  threadId: ThreadId,
  send: Effect.Effect<unknown, E>,
  answer?: "accept" | "decline",
) =>
  Effect.gen(function* () {
    const events = yield* adapter.streamEvents.pipe(
      Stream.filter((event: ProviderRuntimeEvent) => event.threadId === threadId),
      Stream.tap((event) =>
        event.type === "request.opened" && answer
          ? adapter.respondToRequest(threadId, event.requestId as never, answer)
          : Effect.void,
      ),
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* send;
    return Array.from(yield* Fiber.join(events));
  });

const textOf = (events: ReadonlyArray<ProviderRuntimeEvent>, kind = "assistant_text") =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.payload.streamKind === kind
        ? [event.payload.delta]
        : [],
    )
    .join("");

const runTurn = (
  adapter: GrokAdapterShape,
  threadId: ThreadId,
  input: string,
  answer?: "accept" | "decline",
) =>
  Effect.gen(function* () {
    const events = yield* collectTurn(
      adapter,
      threadId,
      adapter.sendTurn({ threadId, input, attachments: [] }),
      answer,
    );
    return {
      events,
      text: textOf(events),
      asked: events.filter((event) => event.type === "request.opened").length,
    };
  });

const start = (
  adapter: GrokAdapterShape,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  extra: { readonly model?: string; readonly resumeCursor?: unknown } = {},
) =>
  adapter.startSession({
    threadId,
    provider: PROVIDER,
    cwd: process.cwd(),
    runtimeMode,
    modelSelection: { instanceId, model: extra.model ?? "grok-4.6" },
    ...(extra.resumeCursor !== undefined ? { resumeCursor: extra.resumeCursor } : {}),
  });

it.effect(
  "with an API key: extension client, default permission mode, MCP goes through, a shell command asks",
  () =>
    Effect.gen(function* () {
      const machine = yield* makeMachine({ signedIn: false });
      yield* withAdapter({ ...machine.env, XAI_API_KEY: "test-key" }, (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("grok-key");
          yield* start(adapter, threadId, "approval-required");
          const first = yield* runTurn(adapter, threadId, "hello");
          assert.equal(
            first.text,
            "client=extension auth=xai.api_key model=grok-4.6 permission=default cancel=none",
          );
          const mcp = yield* runTurn(adapter, threadId, "DO_MCP");
          assert.equal(mcp.asked, 0);
          assert.match(mcp.text, /^mcp allowed; /);
          const declined = yield* runTurn(adapter, threadId, "DO_SHELL", "decline");
          assert.equal(declined.asked, 1);
          assert.match(declined.text, /^shell denied; /);
          const accepted = yield* runTurn(adapter, threadId, "DO_SHELL", "accept");
          assert.equal(accepted.asked, 1);
          assert.match(accepted.text, /^shell allowed; /);
          yield* adapter.stopSession(threadId);
        }),
      );
    }),
);

it.effect("signed in to xAI: authenticates with the stored sign-in, picks the chosen model", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: true });
    yield* withAdapter(machine.env, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-signed-in");
        yield* start(adapter, threadId, "full-access", { model: "grok-4.5" });
        const turn = yield* runTurn(adapter, threadId, "hello");
        assert.match(turn.text, /auth=cached_token model=grok-4\.5 permission=default/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("refuses to start without a sign-in, instead of waiting on Grok forever", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    yield* withAdapter(machine.env, (adapter) =>
      Effect.gen(function* () {
        const exit = yield* start(adapter, ThreadId.make("grok-no-login"), "full-access").pipe(
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /Grok is not signed in/);
      }),
    );
  }),
);

it.effect("a refused API key comes back as a failed turn with xAI's own words", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    yield* withAdapter({ ...machine.env, XAI_API_KEY: "bad-key" }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-api-error");
        yield* start(adapter, threadId, "approval-required");
        const sent = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "DO_API_ERROR", attachments: [] }),
        );
        assert.ok(Exit.isFailure(sent));
        const failure = Cause.findErrorOption(sent.cause);
        assert.ok(Option.isSome(failure), Cause.pretty(sent.cause));
        assert.match(String(failure.value.message), /Incorrect API key provided/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("never sends Grok a slash command that turns its permission prompts off", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    yield* withAdapter({ ...machine.env, XAI_API_KEY: "key" }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-always-approve");
        yield* start(adapter, threadId, "approval-required");
        const sent = yield* Effect.exit(
          adapter.sendTurn({ threadId, input: "  /always-approve", attachments: [] }),
        );
        assert.ok(Exit.isFailure(sent));
        const failure = Cause.findErrorOption(sent.cause);
        assert.ok(Option.isSome(failure), Cause.pretty(sent.cause));
        assert.match(String(failure.value.message), /turned off in Uno Work/);
        // The session still works, and the agent never saw the command.
        const after = yield* runTurn(adapter, threadId, "hello");
        assert.match(after.text, /permission=default/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("a thought streams as reasoning, apart from the reply", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    yield* withAdapter({ ...machine.env, XAI_API_KEY: "test-key" }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-think");
        yield* start(adapter, threadId, "approval-required");
        const turn = yield* runTurn(adapter, threadId, "DO_THINK");
        assert.equal(textOf(turn.events, "reasoning_text"), "Weighing the options. ");
        assert.match(turn.text, /^client=extension /);
        const thought = turn.events.find(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        );
        assert.ok(thought?.itemId, "a thought needs an item id to become the live thought line");
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

it.effect("Stop: Grok gets ctrl_c, the running tool is closed as failed", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    yield* withAdapter({ ...machine.env, XAI_API_KEY: "test-key" }, (adapter) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-cancel");
        yield* start(adapter, threadId, "full-access");
        const events = yield* collectTurn(
          adapter,
          threadId,
          Effect.gen(function* () {
            const toolStarted = yield* adapter.streamEvents.pipe(
              Stream.filter(
                (event) => event.threadId === threadId && event.type === "item.updated",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const turn = yield* adapter
              .sendTurn({ threadId, input: "DO_HANG", attachments: [] })
              .pipe(Effect.forkChild);
            yield* Fiber.join(toolStarted);
            yield* adapter.interruptTurn(threadId);
            yield* Fiber.join(turn);
          }),
        );
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(
          completed?.type === "turn.completed" ? completed.payload.state : "",
          "cancelled",
        );
        const closed = events.find(
          (event) => event.type === "item.completed" && String(event.itemId) === "long-1",
        );
        assert.equal(closed?.type === "item.completed" ? closed.payload.status : "", "failed");
        const next = yield* runTurn(adapter, threadId, "hello");
        assert.match(next.text, /cancel=ctrl_c$/);
        yield* adapter.stopSession(threadId);
      }),
    );
  }),
);

// Live clock: the load deadline is a real timer.
it.live("a resumed chat drops Grok's replay; a load that never answers opens a new session", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine({ signedIn: false });
    const env = { ...machine.env, XAI_API_KEY: "test-key" };
    const threadId = ThreadId.make("grok-resume");
    const first = yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter, threadId, "full-access");
        yield* adapter.stopSession(threadId);
        return session;
      }),
    );
    const resumedId = (first.resumeCursor as { sessionId: string }).sessionId;
    yield* withAdapter(env, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter, threadId, "full-access", {
          resumeCursor: first.resumeCursor,
        });
        assert.equal((session.resumeCursor as { sessionId: string }).sessionId, resumedId);
        const turn = yield* runTurn(adapter, threadId, "hello");
        assert.notMatch(turn.text, /old reply/);
        yield* adapter.stopSession(threadId);
      }),
    );
    yield* withAdapter(
      { ...env, FAKE_GROK_LOAD_HANGS: "1" },
      (adapter) =>
        Effect.gen(function* () {
          const session = yield* start(adapter, threadId, "full-access", {
            resumeCursor: first.resumeCursor,
          });
          assert.notEqual((session.resumeCursor as { sessionId: string }).sessionId, resumedId);
          const turn = yield* runTurn(adapter, threadId, "hello");
          assert.notMatch(turn.text, /old reply/);
          yield* adapter.stopSession(threadId);
        }),
      { sessionLoadTimeoutMs: 500 },
    );
  }),
);
