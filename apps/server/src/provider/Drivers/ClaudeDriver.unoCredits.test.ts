/**
 * Claude Code on Uno AI asks first (28.10): with no sign-in of its own it
 * would run on the account's Uno credits, and until the person allowed that
 * on this machine nothing goes through the gateway — whoever sends the turn
 * (the composer, Telegram, another agent).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ThreadId,
  isUnoCreditsChoiceRequiredText,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, vi } from "vitest";

import { BrowserBridgeTest } from "../../browserBridge.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { UnoAgentAccessTest } from "../../unoAgentAccess.ts";
import { UnoGatewayKeyTest } from "../../unoGatewayKey.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  ClaudeDriver,
  claudeAuthOverlay,
  claudeUnoCreditsAllowed,
  makeUnoCreditsGuard,
} from "./ClaudeDriver.ts";

const GATEWAY = { ANTHROPIC_BASE_URL: "https://api.getuno.xyz", ANTHROPIC_AUTH_TOKEN: "unollm_k" };

describe("claudeAuthOverlay", () => {
  it("runs on the gateway only on Uno AI with Uno credits allowed", () => {
    assert.deepStrictEqual(
      claudeAuthOverlay({ mode: "uno", unoOverlay: GATEWAY, unoCreditsAllowed: true }),
      GATEWAY,
    );
    assert.deepStrictEqual(
      claudeAuthOverlay({ mode: "uno", unoOverlay: GATEWAY, unoCreditsAllowed: false }),
      {},
    );
    assert.deepStrictEqual(
      claudeAuthOverlay({ mode: "own", unoOverlay: GATEWAY, unoCreditsAllowed: true }),
      {},
    );
    assert.deepStrictEqual(
      claudeAuthOverlay({ mode: "uno", unoOverlay: null, unoCreditsAllowed: true }),
      {},
    );
  });

  it("reads the choice per harness", () => {
    assert.strictEqual(claudeUnoCreditsAllowed({ harnessUnoCredits: {} }), false);
    assert.strictEqual(claudeUnoCreditsAllowed({ harnessUnoCredits: { claudeAgent: true } }), true);
    assert.strictEqual(
      claudeUnoCreditsAllowed({ harnessUnoCredits: { claudeAgent: false } }),
      false,
    );
    assert.strictEqual(claudeUnoCreditsAllowed({ harnessUnoCredits: { codex: true } }), false);
  });
});

describe("makeUnoCreditsGuard", () => {
  it.effect("says why nothing was sent while the choice is pending", () =>
    Effect.gen(function* () {
      let rechecks = 0;
      const guard = makeUnoCreditsGuard({
        pending: () => true,
        recheck: Effect.sync(() => (rechecks += 1)),
        harnessLabel: "Claude Code",
      });
      const exit = yield* Effect.exit(guard("turn/start"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
        const detail = (error as { error: { detail: string } } | undefined)?.error.detail ?? "";
        assert.isTrue(isUnoCreditsChoiceRequiredText(detail));
        assert.include(detail, "Claude Code isn't signed in on this computer");
      }
      assert.strictEqual(rechecks, 1);
    }),
  );

  it.effect("lets the turn through when a fresh check finds a sign-in", () =>
    Effect.gen(function* () {
      let signedIn = false;
      const guard = makeUnoCreditsGuard({
        pending: () => !signedIn,
        recheck: Effect.sync(() => {
          signedIn = true;
        }),
        harnessLabel: "Claude Code",
      });
      yield* guard("session/start");
      assert.isTrue(signedIn);
    }),
  );

  it.effect("does not look again when nothing is pending", () =>
    Effect.gen(function* () {
      let rechecks = 0;
      const guard = makeUnoCreditsGuard({
        pending: () => false,
        recheck: Effect.sync(() => (rechecks += 1)),
        harnessLabel: "Claude Code",
      });
      yield* guard("turn/start");
      assert.strictEqual(rechecks, 0);
    }),
  );
});

// ── The driver end to end: status check → guarded adapter ─────────────

const encoder = new TextEncoder();

function claudeCliLayer(loggedIn: boolean) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = (command as unknown as { args: ReadonlyArray<string> }).args.join(" ");
      const stdout =
        args === "--version"
          ? "2.1.290 (Claude Code)\n"
          : args === "auth status --json"
            ? JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })
            : "";
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

function driverLayer(input: {
  readonly loggedIn: boolean;
  readonly harnessUnoCredits: Record<string, boolean>;
}) {
  return ServerConfig.layerTest(process.cwd(), { prefix: "claude-uno-credits-test" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BrowserBridgeTest),
    Layer.provideMerge(UnoAgentAccessTest),
    Layer.provideMerge(UnoGatewayKeyTest("unollm_machine_key")),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ harnessUnoCredits: input.harnessUnoCredits }),
    ),
  );
}

/** The fake `claude` CLI wins over NodeServices' real spawner (the right side of a merge wins). */
const withDriver =
  (input: Parameters<typeof driverLayer>[0]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.merge(driverLayer(input), claudeCliLayer(input.loggedIn))));

/** Starts a Claude session on a fresh instance; the snapshot is checked first. */
const startOnFreshInstance = Effect.gen(function* () {
  const instance = yield* ClaudeDriver.create({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: undefined,
    environment: [],
    enabled: true,
    // Not a real binary: the CLI answers come from the spawner above, and the
    // SDK's capabilities probe fails fast instead of starting a real Claude.
    config: Schema.decodeSync(ClaudeSettings)({ binaryPath: "/nonexistent/claude-uno-credits" }),
  });
  yield* instance.snapshot.refresh;
  const threadId = ThreadId.make("thread-uno-credits");
  const started = yield* Effect.exit(
    instance.adapter.sendTurn({ threadId, input: "hello" } as never),
  );
  return { started };
});

const failureDetail = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (!Exit.isFailure(exit)) return null;
  const reason = exit.cause.reasons.find((candidate) => candidate._tag === "Fail") as
    | { readonly error: { readonly detail?: string; readonly message?: string } }
    | undefined;
  return reason?.error.detail ?? reason?.error.message ?? "";
};

describe("ClaudeDriver — Uno credits only by choice", () => {
  // The plan check behind Claude on Uno AI: answered "no word" (allowed).
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.live("not signed in, no choice yet: the turn is refused with the way out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started } = yield* startOnFreshInstance;
        const detail = failureDetail(started);
        assert.isTrue(isUnoCreditsChoiceRequiredText(detail), String(detail));
      }),
    ).pipe(withDriver({ loggedIn: false, harnessUnoCredits: {} })),
  );

  it.live("Uno credits allowed: the turn reaches Claude (no refusal)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started } = yield* startOnFreshInstance;
        // No session in this test, so the adapter itself answers — not the guard.
        assert.isFalse(isUnoCreditsChoiceRequiredText(failureDetail(started)));
      }),
    ).pipe(withDriver({ loggedIn: false, harnessUnoCredits: { claudeAgent: true } })),
  );

  it.live("signed in with the person's own account: never asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started } = yield* startOnFreshInstance;
        assert.isFalse(isUnoCreditsChoiceRequiredText(failureDetail(started)));
      }),
    ).pipe(withDriver({ loggedIn: true, harnessUnoCredits: {} })),
  );
});
