/**
 * End to end with the documented example: examples/acp-echo-harness is
 * spawned for real (node), driven through AcpSessionRuntime by the custom
 * harness adapter — a turn, a plan, and an Approve / Deny round-trip — and
 * through the Test connection routine.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect";

import {
  CustomHarnessSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { runHarnessTest } from "../customHarness/CustomHarnessService.ts";
import {
  type CustomHarnessAdapterShape,
  makeCustomHarnessAdapter,
} from "./CustomHarnessAdapter.ts";

class EchoAdapter extends Context.Service<EchoAdapter, CustomHarnessAdapterShape>()(
  "test/EchoHarnessAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const echoHarness = path.resolve(
  __dirname,
  "../../../../../examples/acp-echo-harness/echo-harness.mjs",
);
const instanceId = ProviderInstanceId.make("harness-echo");
const PROVIDER = ProviderDriverKind.make("acp");

const echoConfig = Schema.decodeSync(CustomHarnessSettings)({
  command: process.execPath,
  args: [echoHarness],
});

const layer = it.layer(
  Layer.effect(
    EchoAdapter,
    makeCustomHarnessAdapter(echoConfig, {
      instanceId,
      displayName: "Echo",
      environment: { PATH: process.env.PATH ?? "" },
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "uno-echo-harness-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const collectUntil = (
  adapter: CustomHarnessAdapterShape,
  predicate: (event: ProviderRuntimeEvent) => boolean,
) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.forkChild,
  );

layer("CustomHarnessAdapter + acp-echo-harness", (it) => {
  it.effect("runs a turn with a plan and streamed text", () =>
    Effect.gen(function* () {
      const adapter = yield* EchoAdapter;
      const threadId = ThreadId.make("echo-turn");
      const session = yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "default" },
      });
      assert.equal(session.provider, "acp");
      assert.equal(session.providerInstanceId, instanceId);

      const eventsFiber = yield* collectUntil(adapter, (event) => event.type === "turn.completed");
      yield* adapter.sendTurn({ threadId, input: "make a plan please", attachments: [] });
      const events = yield* Fiber.join(eventsFiber);
      const text = events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      assert.equal(text, "Echo: make a plan please");
      const plan = events.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(plan);
      if (plan?.type === "turn.plan.updated") {
        assert.deepStrictEqual(plan.payload.plan, [
          { step: "Read the request", status: "completed" },
          { step: "Echo it back", status: "inProgress" },
        ]);
      }
      const completed = events.at(-1);
      assert.equal(completed?.type, "turn.completed");
      yield* adapter.stopSession(threadId);
    }),
  );

  for (const [decision, expected] of [
    ["accept", "Permission granted. "],
    ["decline", "Permission denied. "],
  ] as const) {
    it.effect(`round-trips a permission request (${decision})`, () =>
      Effect.gen(function* () {
        const adapter = yield* EchoAdapter;
        const threadId = ThreadId.make(`echo-permission-${decision}`);
        yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const allFiber = yield* collectUntil(
          adapter,
          (event) => event.type === "turn.completed" && event.threadId === threadId,
        );
        const openedFiber = yield* collectUntil(
          adapter,
          (event) => event.type === "request.opened" && event.threadId === threadId,
        );
        yield* Effect.yieldNow;
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "write notes", attachments: [] })
          .pipe(Effect.forkChild);
        const opened = (yield* Fiber.join(openedFiber)).at(-1);
        assert.equal(opened?.type, "request.opened");
        if (opened?.type !== "request.opened") return;

        yield* adapter.respondToRequest(threadId, opened.requestId as never, decision);
        yield* Fiber.join(turnFiber);
        const rest = yield* Fiber.join(allFiber);
        const text = rest
          .flatMap((event) =>
            event.type === "content.delta" && event.threadId === threadId
              ? [event.payload.delta]
              : [],
          )
          .join("");
        assert.equal(text, `${expected}Echo: write notes`);
        assert.isTrue(rest.some((event) => event.type === "request.resolved"));
        yield* adapter.stopSession(threadId);
      }),
    );
  }

  it.effect("full-access approves without asking", () =>
    Effect.gen(function* () {
      const adapter = yield* EchoAdapter;
      const threadId = ThreadId.make("echo-full-access");
      yield* adapter.startSession({
        threadId,
        provider: PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const eventsFiber = yield* collectUntil(
        adapter,
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );
      yield* adapter.sendTurn({ threadId, input: "write it", attachments: [] });
      const events = yield* Fiber.join(eventsFiber);
      assert.isFalse(events.some((event) => event.type === "request.opened"));
      const text = events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      assert.equal(text, "Permission granted. Echo: write it");
      yield* adapter.stopSession(threadId);
    }),
  );
});

describe("Test connection (runHarnessTest) + acp-echo-harness", () => {
  it.live("Test connection passes against the echo harness", () =>
    Effect.gen(function* () {
      const result = yield* runHarnessTest({
        config: echoConfig,
        environment: { PATH: process.env.PATH ?? "" },
      }).pipe(Effect.provide(NodeServices.layer));
      assert.isTrue(result.ok, result.error);
      assert.equal(result.stage, "done");
      assert.equal(result.reply, "Echo: Reply with OK.");
      assert.equal(result.agentName, "acp-echo");
      assert.equal(result.protocolVersion, 1);
      assert.equal(result.stopReason, "end_turn");
    }),
  );

  it.live("Test connection explains a harness that is not an ACP agent", () =>
    Effect.gen(function* () {
      const notAcp = Schema.decodeSync(CustomHarnessSettings)({
        command: process.execPath,
        args: ["-e", "console.error('boom: no ACP here'); process.exit(3)"],
      });
      const result = yield* runHarnessTest({
        config: notAcp,
        environment: { PATH: process.env.PATH ?? "" },
      }).pipe(Effect.provide(NodeServices.layer));
      assert.isFalse(result.ok);
      assert.equal(result.stage, "initialize");
      assert.include(result.stderr, "boom: no ACP here");
    }),
  );

  it.live("Test connection reports a missing command before spawning", () =>
    Effect.gen(function* () {
      const result = yield* runHarnessTest({
        config: Schema.decodeSync(CustomHarnessSettings)({ command: "definitely-not-an-agent" }),
        environment: { PATH: "/nonexistent" },
      }).pipe(Effect.provide(NodeServices.layer));
      assert.isFalse(result.ok);
      assert.equal(result.stage, "spawn");
      assert.match(result.error ?? "", /not found on PATH/);
    }),
  );

  it.live(
    "Test connection times out and kills an agent that never answers (even ignoring SIGTERM)",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "uno-silent-agent-")),
        );
        const script = path.join(dir, "silent.mjs");
        const pidFile = path.join(dir, "pid");
        yield* Effect.promise(() =>
          writeFile(
            script,
            `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);`,
          ),
        );
        const started = Date.now();
        const result = yield* runHarnessTest({
          config: Schema.decodeSync(CustomHarnessSettings)({
            command: process.execPath,
            args: [script],
          }),
          environment: { PATH: process.env.PATH ?? "" },
          timeoutMs: 1_000,
        }).pipe(Effect.provide(NodeServices.layer));
        assert.isFalse(result.ok);
        assert.equal(result.stage, "initialize");
        assert.match(result.error ?? "", /No answer within 1 s/);
        assert.isBelow(Date.now() - started, 10_000);
        const pid = Number(yield* Effect.promise(() => readFile(pidFile, "utf8")));
        const alive = (() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })();
        assert.isFalse(alive, "the agent process must be gone");
      }),
    20_000,
  );
});
