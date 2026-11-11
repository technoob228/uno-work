import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  // environment-hint.txt: what Hermes' embedder slot got for this session
  // (the env wins over config.yaml, so this is what the model would see).
  await writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      `export PATH=${JSON.stringify(process.env.PATH ?? "")}`,
      'if [ -d "$HERMES_HOME" ]; then printf \'%s\' "$HERMES_ENVIRONMENT_HINT" > "$HERMES_HOME/environment-hint.txt"; fi',
      `exec bun ${JSON.stringify(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
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

// ── The projects an assistant manages (assistants/projectsHint.ts) ──────

const PROJECTS_BLOCK = [
  "The person's projects on this computer — you manage them all (1). A task about one of them → chat_create with its folder as `cwd`.",
  "- uno-project · ~/projects/uno-project — UNO: hosting, client servers and their tickets. [its instructions: CLAUDE.md]",
].join("\n");

const UNO_WORK_BRIEF = "# You are working inside Uno Work";

/** What Hermes' embedder slot got when this thread's session started. */
const environmentHintOf = (threadId: string) =>
  readFile(
    path.join(assistantProjectsState.hermesHome, "threads", threadId, "environment-hint.txt"),
    "utf8",
  );

/** What `session/prompt` carried, in order (the mock agent's request log). */
async function promptTexts(logPath: string): Promise<ReadonlyArray<string>> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          method?: string;
          params?: { prompt?: ReadonlyArray<{ type: string; text?: string }> };
        },
    )
    .filter((request) => request.method === "session/prompt")
    .map((request) => (request.params?.prompt ?? []).map((part) => part.text ?? "").join("\n"));
}

const assistantProjectsState: { block: string | null; hermesHome: string; log: string } = {
  block: PROJECTS_BLOCK,
  hermesHome: "",
  log: "",
};

const assistantProjectsLayer = it.layer(
  Layer.effect(
    HermesAdapter,
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockHermes());
      assistantProjectsState.hermesHome = mock.hermesHome;
      assistantProjectsState.log = path.join(path.dirname(mock.wrapperPath), "requests.ndjson");
      return yield* makeHermesAdapter(
        Schema.decodeSync(HermesSettings)({ binaryPath: mock.wrapperPath }),
        {
          environment: {
            HERMES_HOME: mock.hermesHome,
            T3_ACP_REQUEST_LOG_PATH: assistantProjectsState.log,
            // What the driver always puts there (HermesDriver.ts).
            HERMES_ENVIRONMENT_HINT: UNO_WORK_BRIEF,
          },
          assistantProjects: () => Effect.sync(() => assistantProjectsState.block),
        },
      );
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-adapter-projects-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** A named assistant's folder: the marker is what makes it one. */
async function makeAssistantWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-assistant-ws-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, ".uno-assistant.json"),
    JSON.stringify({ projectId: "assistant-chief" }),
    "utf8",
  );
  await writeFile(path.join(dir, "SOUL.md"), "# Who I am\nТы Купер, помощник Миши.\n", "utf8");
  return dir;
}

assistantProjectsLayer("an assistant's projects reach its session", (it) => {
  it.effect(
    "a new session has them in its system prompt, and its cursor says with which list",
    () =>
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        const cwd = yield* Effect.promise(() => makeAssistantWorkspace());
        const threadId = ThreadId.make("chief-new");
        assistantProjectsState.block = PROJECTS_BLOCK;

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd,
          runtimeMode: "full-access",
        });
        const config = yield* Effect.promise(() =>
          readFile(
            path.join(assistantProjectsState.hermesHome, "threads", threadId, "config.yaml"),
            "utf8",
          ),
        );
        assert.include(config, "environment_hint");
        assert.include(config, "Your projects");
        assert.include(config, "~/projects/uno-project");
        // The env wins over the config in Hermes: a named assistant keeps
        // the Uno Work brief and gets its own files and projects after it.
        const hint = yield* Effect.promise(() => environmentHintOf(threadId));
        assert.isTrue(hint.startsWith(UNO_WORK_BRIEF));
        assert.include(hint, "Ты Купер, помощник Миши.");
        assert.include(hint, "- uno-project · ~/projects/uno-project — UNO");
        const cursor = session.resumeCursor as { projectsStamp?: string; promptStamp?: string };
        assert.isString(cursor.projectsStamp);
        assert.isString(cursor.promptStamp);

        // The list is in the prompt already: the message goes as it is.
        yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
        // A project added while the session runs comes with the next message, once.
        assistantProjectsState.block = `${PROJECTS_BLOCK}\n- site · ~/projects/site`;
        yield* adapter.sendTurn({ threadId, input: "and now?", attachments: [] });
        yield* adapter.sendTurn({ threadId, input: "third", attachments: [] });
        const prompts = (yield* Effect.promise(() =>
          promptTexts(assistantProjectsState.log),
        )).slice(-3);
        assert.notInclude(prompts[0]!, "Your projects");
        assert.include(prompts[1]!, "[Your projects changed since this session started");
        assert.include(prompts[1]!, "- site · ~/projects/site");
        assert.isTrue(prompts[1]!.endsWith("and now?"));
        assert.notInclude(prompts[2]!, "Your projects");

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "a session from before its files reached the prompt (Cooper's, 10.11) starts fresh, with them",
    () =>
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        const cwd = yield* Effect.promise(() => makeAssistantWorkspace());
        const threadId = ThreadId.make("chief-old");
        assistantProjectsState.block = PROJECTS_BLOCK;

        // Hermes froze that session's system prompt when it was created, and
        // a named assistant's own files were never in it. Its cursor has no
        // stamp: resuming it would keep the assistant blind.
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "session-of-10-11" },
        });
        const cursor = session.resumeCursor as {
          sessionId: string;
          promptStamp?: string;
          projectsStamp?: string;
        };
        assert.notStrictEqual(cursor.sessionId, "session-of-10-11");
        assert.isString(cursor.promptStamp);
        assert.isString(cursor.projectsStamp);
        const hint = yield* Effect.promise(() => environmentHintOf(threadId));
        assert.include(hint, "- uno-project · ~/projects/uno-project — UNO");

        // The list is in the new prompt: no second copy with the message.
        yield* adapter.sendTurn({
          threadId,
          input: "Сервер bright-falcon #1086: не могу войти по SSH",
          attachments: [],
        });
        const prompts = (yield* Effect.promise(() =>
          promptTexts(assistantProjectsState.log),
        )).slice(-1);
        assert.notInclude(prompts[0]!, "<Your projects>");
        assert.isTrue(prompts[0]!.endsWith("Сервер bright-falcon #1086: не могу войти по SSH"));

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "a session that comes back with another list gets the list of now with the first message",
    () =>
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        const cwd = yield* Effect.promise(() => makeAssistantWorkspace());
        const threadId = ThreadId.make("chief-back");
        assistantProjectsState.block = PROJECTS_BLOCK;

        const first = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd,
          runtimeMode: "full-access",
        });
        yield* adapter.stopSession(threadId);

        // The daemon restarted; a project was added meanwhile. Same
        // instructions → the same session, whose frozen prompt has the old list.
        assistantProjectsState.block = `${PROJECTS_BLOCK}\n- site · ~/projects/site`;
        const back = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd,
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        const before = first.resumeCursor as { sessionId: string; projectsStamp?: string };
        const cursor = back.resumeCursor as { sessionId: string; projectsStamp?: string };
        assert.strictEqual(cursor.sessionId, before.sessionId);
        // Still "built with the old list": the next restart says it again.
        assert.strictEqual(cursor.projectsStamp, before.projectsStamp);

        yield* adapter.sendTurn({ threadId, input: "что по сайту?", attachments: [] });
        yield* adapter.sendTurn({ threadId, input: "ну что?", attachments: [] });
        const prompts = (yield* Effect.promise(() =>
          promptTexts(assistantProjectsState.log),
        )).slice(-2);
        assert.include(prompts[0]!, "[Your projects changed since this session started");
        assert.include(prompts[0]!, "- site · ~/projects/site");
        assert.isTrue(prompts[0]!.endsWith("что по сайту?"));
        assert.notInclude(prompts[1]!, "Your projects");

        yield* adapter.stopSession(threadId);
      }),
  );
});
