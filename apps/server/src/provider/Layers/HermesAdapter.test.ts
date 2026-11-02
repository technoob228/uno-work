import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  HermesSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";
import {
  HERMES_SESSION_LOST_MESSAGE,
  hermesPermissionWaitMs,
  makeHermesAdapter,
} from "./HermesAdapter.ts";

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

const makeHermesAdapterTestLayer = (
  environment: Record<string, string> = {},
  options?: { readonly permissionWaitMs?: number },
) =>
  it.layer(
    Layer.effect(
      HermesAdapter,
      Effect.gen(function* () {
        const mock = yield* Effect.promise(() => makeMockHermes());
        return yield* makeHermesAdapter(
          Schema.decodeSync(HermesSettings)({ binaryPath: mock.wrapperPath }),
          { environment: { HERMES_HOME: mock.hermesHome, ...environment }, ...options },
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

/** As Hermes offers them for a file edit (acp_adapter/edit_approval.py). */
const HERMES_EDIT_OPTIONS = [
  { optionId: "allow_once", name: "Allow edit", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
/** As it offers them for a command (acp_adapter/permissions.py). */
const HERMES_COMMAND_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
];

/** The turn up to the card; the person's answer; what the agent understood from it. */
const askAndAnswer = (
  adapter: HermesAdapterShape,
  threadId: ThreadId,
  decision: ProviderApprovalDecision,
) =>
  Effect.gen(function* () {
    const eventsFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    const openedFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("hermes"),
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
    });
    const turnFiber = yield* adapter
      .sendTurn({ threadId, input: "change a file", attachments: [] })
      .pipe(Effect.forkChild);
    const opened = yield* Fiber.join(openedFiber);
    assert.isTrue(opened._tag === "Some");
    if (opened._tag !== "Some") return "";
    yield* adapter.respondToRequest(threadId, opened.value.requestId as never, decision);
    yield* Fiber.join(turnFiber);
    const events = Array.from(yield* Fiber.join(eventsFiber));
    yield* adapter.stopSession(threadId);
    return events
      .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
      .join("");
  });

for (const [name, options, expected] of [
  [
    "a file edit",
    HERMES_EDIT_OPTIONS,
    {
      accept: "allowed: allow_once",
      acceptForSession: "allowed: allow_once",
      decline: "refused: deny",
    },
  ],
  [
    "a command",
    HERMES_COMMAND_OPTIONS,
    {
      accept: "allowed: allow_once",
      acceptForSession: "allowed: allow_session",
      decline: "refused: deny",
    },
  ],
] as const) {
  makeHermesAdapterTestLayer({
    T3_ACP_EMIT_TOOL_CALLS: "1",
    T3_ACP_PERMISSION_OPTIONS: JSON.stringify(options),
  })(`HermesAdapterLive permission for ${name}`, (it) => {
    for (const [decision, understood] of Object.entries(expected)) {
      it.effect(`${decision} reaches the agent as ${understood}`, () =>
        Effect.gen(function* () {
          const adapter = yield* HermesAdapter;
          const threadId = ThreadId.make(`hermes-permission-${name}-${decision}`);
          const text = yield* askAndAnswer(adapter, threadId, decision as ProviderApprovalDecision);
          assert.include(text, understood);
        }),
      );
    }
  });
}

describe("hermesPermissionWaitMs", () => {
  it("waits as long as this Hermes does, and ends first", () => {
    assert.strictEqual(hermesPermissionWaitMs("0.19.0"), 55_000);
    assert.strictEqual(hermesPermissionWaitMs(undefined), 55_000);
    assert.strictEqual(hermesPermissionWaitMs("0.21.5"), 1_795_000);
    assert.strictEqual(hermesPermissionWaitMs("1.0.0"), 1_795_000);
  });
});

// "Always allow" on a file: Hermes only offers Allow, the standing permission is its mode.
const alwaysAllowLog = path.join(os.tmpdir(), `hermes-always-allow-${process.pid}.ndjson`);
makeHermesAdapterTestLayer({
  T3_ACP_EMIT_TOOL_CALLS: "1",
  T3_ACP_PERMISSION_OPTIONS: JSON.stringify(HERMES_EDIT_OPTIONS),
  T3_ACP_PERMISSION_TOOL_KIND: "edit",
  T3_ACP_REQUEST_LOG_PATH: alwaysAllowLog,
})("HermesAdapterLive always allow on a file edit", (it) => {
  it.effect("keeps edits allowed for the rest of the session", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const threadId = ThreadId.make("hermes-always-allow-edit");
      const text = yield* askAndAnswer(adapter, threadId, "acceptForSession");
      assert.include(text, "allowed: allow_once");
      const log = yield* Effect.promise(() => readFile(alwaysAllowLog, "utf8"));
      const modes = log
        .split("\n")
        .filter((line) => line.includes('"session/set_mode"'))
        .map((line) => (JSON.parse(line) as { params: { modeId: string } }).params.modeId);
      assert.deepStrictEqual(modes, ["default", "dont_ask"]);
    }),
  );
});

// Hermes gives up on an unanswered request by itself and tells nobody.
makeHermesAdapterTestLayer(
  {
    T3_ACP_EMIT_TOOL_CALLS: "1",
    T3_ACP_PERMISSION_OPTIONS: JSON.stringify(HERMES_EDIT_OPTIONS),
  },
  { permissionWaitMs: 55_000 },
)("HermesAdapterLive unanswered permission", (it) => {
  it.effect("closes the card before the agent gives up, and a late click finds nothing", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const threadId = ThreadId.make("hermes-permission-unanswered");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      let closed = false;
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.resolved"),
        Stream.runForEach(() => Effect.sync(() => (closed = true))),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "change a file", attachments: [] })
        .pipe(Effect.forkChild);
      const opened = yield* Fiber.join(openedFiber);
      if (opened._tag !== "Some") return assert.fail("no permission request");

      // The wait starts a moment after the card opens: the clock moves until it's over.
      for (let tick = 0; tick < 100 && !closed; tick += 1) {
        yield* TestClock.adjust("55 seconds");
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      yield* Fiber.join(turnFiber);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const resolved = events.find((event) => event.type === "request.resolved");
      assert.strictEqual(resolved?.payload.decision, "expired");
      const text = events
        .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
        .join("");
      assert.include(text, "refused");

      const late = yield* adapter
        .respondToRequest(threadId, opened.value.requestId as never, "accept")
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(late));
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

// Hermes answers `refusal` to a prompt for a session it lost (02.11.2026).
makeHermesAdapterTestLayer({ T3_ACP_PROMPT_REFUSAL: "1" })(
  "HermesAdapterLive lost session",
  (it) => {
    it.effect("fails the turn and closes the session so the next turn opens a new one", () =>
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        const threadId = ThreadId.make("hermes-lost-session");

        const eventsFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed" || event.type === "session.exited",
        ).pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
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
        const turnCompleted = events.find((event) => event.type === "turn.completed");
        if (turnCompleted?.type !== "turn.completed") throw new Error("no turn.completed");
        assert.strictEqual(turnCompleted.turnId, turnId);
        assert.strictEqual(turnCompleted.payload.state, "failed");
        assert.strictEqual(turnCompleted.payload.errorMessage, HERMES_SESSION_LOST_MESSAGE);
        assert.isTrue(events.some((event) => event.type === "session.exited"));
        assert.isFalse(yield* adapter.hasSession(threadId));
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
