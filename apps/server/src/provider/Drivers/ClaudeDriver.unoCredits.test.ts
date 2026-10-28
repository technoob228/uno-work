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
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  ThreadId,
  isUnoCreditsChoiceRequiredText,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
import {
  claudeConfigDir,
  claudeRanOnUnoGateway,
  isUnoGatewayTranscriptRecord,
  migrateUnoCreditsConsent,
} from "./claudeUnoCreditsMigration.ts";

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
  readonly harnessUnoCreditsMigrated?: Record<string, boolean>;
  readonly home?: string;
}) {
  return ServerConfig.layerTest(process.cwd(), { prefix: "claude-uno-credits-test" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BrowserBridgeTest),
    Layer.provideMerge(UnoAgentAccessTest),
    Layer.provideMerge(UnoGatewayKeyTest("unollm_machine_key")),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        harnessUnoCredits: input.harnessUnoCredits,
        // An upgraded machine by default: the first-start check is its own test.
        harnessUnoCreditsMigrated: input.harnessUnoCreditsMigrated ?? { claudeAgent: true },
      }),
    ),
  );
}

/** The fake `claude` CLI wins over NodeServices' real spawner (the right side of a merge wins). */
const withDriver =
  (input: Parameters<typeof driverLayer>[0]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.merge(driverLayer(input), claudeCliLayer(input.loggedIn))));

/** Starts a Claude session on a fresh instance; the snapshot is checked first. */
const startOnInstance = (home?: string) =>
  Effect.gen(function* () {
    const instance = yield* ClaudeDriver.create({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      displayName: undefined,
      environment: [],
      enabled: true,
      // Not a real binary: the CLI answers come from the spawner above, and the
      // SDK's capabilities probe fails fast instead of starting a real Claude.
      config: Schema.decodeSync(ClaudeSettings)({
        binaryPath: "/nonexistent/claude-uno-credits",
        ...(home ? { homePath: home } : {}),
      }),
    });
    yield* instance.snapshot.refresh;
    const threadId = ThreadId.make("thread-uno-credits");
    const started = yield* Effect.exit(
      instance.adapter.sendTurn({ threadId, input: "hello" } as never),
    );
    const settings = yield* (yield* ServerSettingsService).getSettings;
    return { started, settings };
  });
const startOnFreshInstance = startOnInstance();

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

// ── First start of this version: keep machines that already used it ────

const GATEWAY_ANSWER = {
  type: "assistant",
  entrypoint: "sdk-ts",
  message: { id: "gen-1790000000-abc", model: "claude-sonnet-5", role: "assistant" },
};
const ANTHROPIC_ANSWER = {
  type: "assistant",
  requestId: "req_011Cg9ozwdSaCYb7CERoPmkK",
  message: { id: "msg_011Cg9ozwr5wqV6kMXtPHZCM", model: "claude-opus-5-5" },
};
const LOCAL_ERROR = {
  type: "assistant",
  message: { id: "3dbca30e-1", model: "<synthetic>" },
};

/** A HOME whose Claude Code has one session transcript with these lines. */
function homeWithTranscript(lines: ReadonlyArray<unknown>): string {
  const home = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-uno-history-"));
  const dir = NodePath.join(home, ".claude", "projects", "-home-unowork-project");
  NodeFs.mkdirSync(dir, { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(dir, "8da56484-3967-4882-bfa7-daafb3ad7523.jsonl"),
    [{ type: "user", message: { role: "user", content: "hi" } }, ...lines]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return home;
}

describe("Claude Code's own transcripts tell the way a turn went", () => {
  it("gateway answers: upstream id, no request id; Anthropic: msg_/req_", () => {
    assert.isTrue(isUnoGatewayTranscriptRecord(GATEWAY_ANSWER));
    assert.isTrue(
      isUnoGatewayTranscriptRecord({
        type: "assistant",
        message: { id: "msg_uno_stream", model: "x" },
      }),
    );
    assert.isFalse(isUnoGatewayTranscriptRecord(ANTHROPIC_ANSWER));
    assert.isFalse(isUnoGatewayTranscriptRecord(LOCAL_ERROR));
    assert.isFalse(isUnoGatewayTranscriptRecord({ type: "user", message: { id: "gen-1" } }));
  });

  it("scans the config dir's projects", async () => {
    const used = homeWithTranscript([ANTHROPIC_ANSWER, GATEWAY_ANSWER]);
    const never = homeWithTranscript([ANTHROPIC_ANSWER, LOCAL_ERROR]);
    const env = {};
    assert.isTrue(
      await claudeRanOnUnoGateway({
        configDir: claudeConfigDir({ homePath: used, environment: env }),
      }),
    );
    assert.isFalse(
      await claudeRanOnUnoGateway({
        configDir: claudeConfigDir({ homePath: never, environment: env }),
      }),
    );
    assert.isFalse(await claudeRanOnUnoGateway({ configDir: "/nonexistent/claude-config" }));
    assert.strictEqual(
      claudeConfigDir({ homePath: used, environment: { CLAUDE_CONFIG_DIR: "/srv/claude" } }),
      "/srv/claude",
    );
  });
});

describe("migrateUnoCreditsConsent", () => {
  const run = (
    settings: Pick<ServerSettings, "harnessUnoCredits" | "harnessUnoCreditsMigrated">,
    ranOnUno: boolean,
  ) => {
    const patches: ServerSettingsPatch[] = [];
    let scans = 0;
    return migrateUnoCreditsConsent({
      driver: "claudeAgent",
      getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...settings }),
      updateSettings: (patch) => Effect.sync(() => patches.push(patch)),
      ranOnUno: async () => {
        scans += 1;
        return ranOnUno;
      },
    }).pipe(Effect.map((result) => ({ result, patches, scans: () => scans })));
  };

  it.effect("used Claude on Uno AI before: allowed once, marked", () =>
    Effect.gen(function* () {
      const { result, patches } = yield* run(
        { harnessUnoCredits: {}, harnessUnoCreditsMigrated: {} },
        true,
      );
      assert.strictEqual(result, "allowed");
      assert.deepStrictEqual(patches, [
        {
          harnessUnoCreditsMigrated: { claudeAgent: true },
          harnessUnoCredits: { claudeAgent: true },
        },
      ]);
    }),
  );

  it.effect("never did: asks, marked so it isn't checked again", () =>
    Effect.gen(function* () {
      const { result, patches } = yield* run(
        { harnessUnoCredits: {}, harnessUnoCreditsMigrated: {} },
        false,
      );
      assert.strictEqual(result, "ask");
      assert.deepStrictEqual(patches, [{ harnessUnoCreditsMigrated: { claudeAgent: true } }]);
    }),
  );

  it.effect("checked before: no files read, nothing written", () =>
    Effect.gen(function* () {
      const out = yield* run(
        { harnessUnoCredits: {}, harnessUnoCreditsMigrated: { claudeAgent: true } },
        true,
      );
      assert.strictEqual(out.result, "skipped");
      assert.deepStrictEqual(out.patches, []);
      assert.strictEqual(out.scans(), 0);
    }),
  );

  it.effect("a choice already made (turned off) is never changed", () =>
    Effect.gen(function* () {
      const out = yield* run(
        { harnessUnoCredits: { claudeAgent: false }, harnessUnoCreditsMigrated: {} },
        true,
      );
      assert.strictEqual(out.result, "skipped");
      assert.deepStrictEqual(out.patches, [{ harnessUnoCreditsMigrated: { claudeAgent: true } }]);
      assert.strictEqual(out.scans(), 0);
    }),
  );
});

describe("ClaudeDriver — first start after the upgrade", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const historyHome = homeWithTranscript([GATEWAY_ANSWER]);
  const cleanHome = homeWithTranscript([ANTHROPIC_ANSWER]);

  it.live("machine that ran Claude on Uno AI: allowed by itself, no refusal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, settings } = yield* startOnInstance(historyHome);
        assert.isFalse(isUnoCreditsChoiceRequiredText(failureDetail(started)));
        assert.deepStrictEqual(settings.harnessUnoCredits, { claudeAgent: true });
        assert.deepStrictEqual(settings.harnessUnoCreditsMigrated, { claudeAgent: true });
      }),
    ).pipe(withDriver({ loggedIn: false, harnessUnoCredits: {}, harnessUnoCreditsMigrated: {} })),
  );

  it.live("machine without that history: asked (the turn is refused)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, settings } = yield* startOnInstance(cleanHome);
        assert.isTrue(isUnoCreditsChoiceRequiredText(failureDetail(started)));
        assert.deepStrictEqual(settings.harnessUnoCredits, {});
        assert.deepStrictEqual(settings.harnessUnoCreditsMigrated, { claudeAgent: true });
      }),
    ).pipe(withDriver({ loggedIn: false, harnessUnoCredits: {}, harnessUnoCreditsMigrated: {} })),
  );

  it.live("turned off in Settings, then restarted: stays off despite the history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, settings } = yield* startOnInstance(historyHome);
        assert.isTrue(isUnoCreditsChoiceRequiredText(failureDetail(started)));
        assert.deepStrictEqual(settings.harnessUnoCredits, { claudeAgent: false });
      }),
    ).pipe(
      withDriver({
        loggedIn: false,
        harnessUnoCredits: { claudeAgent: false },
        harnessUnoCreditsMigrated: { claudeAgent: true },
      }),
    ),
  );
});
