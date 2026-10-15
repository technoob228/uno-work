import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

class HermesAdapter extends Context.Service<HermesAdapter, HermesAdapterShape>()(
  "test/HermesAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockHermes() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = path.join(dir, "hermes");
  // PATH: the driver never re-merges the daemon env into the harness's.
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexport PATH=${JSON.stringify(process.env.PATH ?? "")}\nexec bun ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return { wrapperPath, hermesHome: path.join(dir, "home") };
}

const makeHermesAdapterTestLayer = (environment: Record<string, string> = {}) =>
  it.layer(
    Layer.effect(
      HermesAdapter,
      Effect.gen(function* () {
        const mock = yield* Effect.promise(() => makeMockHermes());
        return yield* makeHermesAdapter(
          Schema.decodeSync(HermesSettings)({ binaryPath: mock.wrapperPath }),
          { environment: { HERMES_HOME: mock.hermesHome, ...environment } },
        );
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-adapter-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const hermesAdapterTestLayer = makeHermesAdapterTestLayer();

hermesAdapterTestLayer("HermesAdapterLive", (it) => {
  it.effect("is no longer in a turn once the turn is over; late updates keep its turn id", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const threadId = ThreadId.make("hermes-turn-state");

      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "item.completed" || event.type === "turn.completed",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
      });
      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });

      const [session] = yield* adapter.listSessions();
      assert.strictEqual(session?.activeTurnId, undefined);

      // The assistant segment closes after the prompt returned: still this turn's.
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const itemCompleted = events.find((event) => event.type === "item.completed");
      assert.isDefined(itemCompleted);
      assert.strictEqual(itemCompleted?.turnId, turnId);
      assert.strictEqual(events.find((event) => event.type === "turn.completed")?.turnId, turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  // The assistant prewarm starts the session under Effect.timeout (a race: the
  // start runs in a fiber that ends as soon as it returns). The reply listener
  // must outlive that fiber, or every answer of the session is dropped.
  it.effect("streams replies of a session started inside a race (assistant prewarm)", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const threadId = ThreadId.make("hermes-prewarmed");

      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
        })
        .pipe(Effect.timeout("30 seconds"));

      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "content.delta" || event.type === "turn.completed",
      ).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.isAbove(events.filter((event) => event.type === "content.delta").length, 0);

      yield* adapter.stopSession(threadId);
    }),
  );
});

// Hermes relays a non-retryable gateway 402 as the turn's reply text.
makeHermesAdapterTestLayer({ T3_ACP_PROMPT_RESPONSE_TEXT: "HTTP 402: Insufficient LLM credits" })(
  "HermesAdapterLive billing reply",
  (it) => {
    it.effect("turns the gateway's 402 reply into a human message and a billing failure", () =>
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        const threadId = ThreadId.make("hermes-billing-reply");

        const eventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) =>
            event.type === "content.delta" ||
            event.type === "item.completed" ||
            event.type === "turn.completed" ||
            event.type === "runtime.error",
        ).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
        });
        const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const text = events
          .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
          .join("");
        assert.notInclude(text, "HTTP 402");
        assert.notInclude(text, "Insufficient LLM credits");
        assert.include(text, "https://console.uno4.dev/billing");

        // The reply is finalized before the turn fails (Telegram relays it).
        const itemIndex = events.findIndex((event) => event.type === "item.completed");
        const turnIndex = events.findIndex((event) => event.type === "turn.completed");
        assert.isAtLeast(itemIndex, 0);
        assert.isAbove(turnIndex, itemIndex);
        const turnCompleted = events[turnIndex];
        assert.strictEqual(turnCompleted?.turnId, turnId);
        if (turnCompleted?.type !== "turn.completed") throw new Error("no turn.completed");
        assert.strictEqual(turnCompleted.payload.state, "failed");
        assert.strictEqual(turnCompleted.payload.errorMessage, text);

        yield* adapter.stopSession(threadId);
      }),
    );
  },
);

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Mock ACP agent that never answers `session/prompt` and ignores cancel. */
const makeWedgedHermesLayer = () =>
  Layer.effect(
    HermesAdapter,
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockHermes());
      return yield* makeHermesAdapter(
        Schema.decodeSync(HermesSettings)({ binaryPath: mock.wrapperPath }),
        {
          environment: { HERMES_HOME: mock.hermesHome, T3_ACP_HANG_PROMPT: "1" },
          interruptSettleTimeoutMs: 1_000,
        },
      );
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "starts a queued turn only after the prompt lock and restarts hermes when cancel is ignored",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-wedged-thread");
      const adapter = yield* HermesAdapter;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* sleep(300);
      const secondTurn = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.exit, Effect.forkChild);
      yield* sleep(300);

      // The second turn is queued behind the first prompt: it must not
      // look "working" yet.
      const startedBeforeInterrupt = events.filter((event) => event.type === "turn.started");
      assert.equal(startedBeforeInterrupt.length, 1);
      const firstTurnId = startedBeforeInterrupt[0]?.turnId;

      const interrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      yield* sleep(100);
      // Hermes ignores session/cancel; advance past the settle timeout.
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(interrupt);

      const first = yield* Fiber.join(firstTurn);
      assert.equal(first.turnId, firstTurnId);

      const completed = events.find(
        (event) => event.type === "turn.completed" && event.turnId === firstTurnId,
      );
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "interrupted");
      }
      assert.equal(
        events.some((event) => event.type === "session.exited"),
        true,
      );
      assert.equal(yield* adapter.hasSession(threadId), false);

      // The prompt lock was released: the queued turn got past it (and
      // found the torn-down session) instead of waiting forever. It never
      // emitted turn.started.
      const second = yield* Fiber.join(secondTurn);
      assert.equal(Exit.isFailure(second), true);
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
    }).pipe(Effect.provide(makeWedgedHermesLayer())),
  30_000,
);
