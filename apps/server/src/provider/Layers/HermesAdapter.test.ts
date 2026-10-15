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

/** Mock ACP agent that never answers `session/prompt` and ignores cancel. */
async function makeWedgedMockAgentWrapper() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-hermes.sh");
  const script = `#!/bin/sh
export T3_ACP_HANG_PROMPT=1
exec bun ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const makeLayer = (binaryPath: string, hermesHome: string) =>
  Layer.effect(
    HermesAdapter,
    makeHermesAdapter(Schema.decodeSync(HermesSettings)({ binaryPath }), {
      environment: { HERMES_HOME: hermesHome },
      interruptSettleTimeoutMs: 1_000,
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
      const binaryPath = yield* Effect.promise(() => makeWedgedMockAgentWrapper());
      const hermesHome = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "hermes-home-test-")),
      );
      const threadId = ThreadId.make("hermes-wedged-thread");

      yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(makeLayer(binaryPath, hermesHome)));
    }),
  30_000,
);
