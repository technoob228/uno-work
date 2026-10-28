/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  UNO_GATEWAY_BASE_URL,
  unoCreditsChoiceRequiredText,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Cache, Deferred, Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { UnoAgentAccess } from "../../unoAgentAccess.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import { buildUnoWorkBrief } from "../../agentContext/unoWorkBrief.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { customMcpServersGetter } from "../../mcp/customMcpServers.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  type ClaudeAuthMode,
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeUnoClaudeAvailability } from "./unoClaudeAvailability.ts";
import {
  claudeConfigDir,
  claudeRanOnUnoGateway,
  migrateUnoCreditsConsent,
} from "./claudeUnoCreditsMigration.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
/** How the person knows this harness (the composer's choice says the same). */
const CLAUDE_CODE_LABEL = "Claude Code";
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);
/** A turn that arrives during the first start's history check waits this long for it. */
const UNO_CREDITS_MIGRATION_WAIT = Duration.seconds(20);

/**
 * A capabilities probe that saw who Claude Code is signed in as: a plan, an
 * email, or where its token comes from. Without any of these it ran signed out.
 */
export function capabilitiesFoundAccount(capabilities: {
  readonly email?: string | undefined;
  readonly subscriptionType?: string | undefined;
  readonly tokenSource?: string | undefined;
}): boolean {
  return Boolean(capabilities.subscriptionType || capabilities.email || capabilities.tokenSource);
}

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | UnoAgentAccess
  | UnoGatewayKey
  | ServerConfig
  | ServerSettingsService;

/**
 * Claude Code on Uno AI talks to the gateway's Anthropic Messages API:
 * Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so the base is
 * the gateway host without `/v1`.
 */
export const UNO_ANTHROPIC_BASE_URL = UNO_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

/** Env that runs Claude Code on the Uno gateway with the machine's gateway key. */
export function unoClaudeEnvironment(gatewayKey: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: UNO_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: gatewayKey,
  };
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

/** The person allowed Claude Code to run on the account's Uno credits on this machine. */
export function claudeUnoCreditsAllowed(
  settings: Pick<ServerSettings, "harnessUnoCredits">,
): boolean {
  return settings.harnessUnoCredits?.[DRIVER_KIND] === true;
}

/**
 * The env Claude Code runs with on top of its own: the Uno gateway only on
 * Uno AI (no sign-in of its own) and only once Uno credits are allowed here.
 */
export function claudeAuthOverlay(input: {
  readonly mode: ClaudeAuthMode;
  readonly unoOverlay: Readonly<Record<string, string>> | null;
  readonly unoCreditsAllowed: boolean;
}): Record<string, string> {
  return input.mode === "uno" && input.unoOverlay !== null && input.unoCreditsAllowed
    ? { ...input.unoOverlay }
    : {};
}

/**
 * Refuses a session / turn that would run on Uno AI before the person chose
 * between signing in and Uno credits. `pending` is read again after
 * `recheck` (a fresh status check): a sign-in from a terminal lands only on
 * the next 5-minute check otherwise.
 */
export function makeUnoCreditsGuard(input: {
  readonly pending: () => boolean;
  readonly recheck: Effect.Effect<unknown>;
  readonly harnessLabel: string;
}) {
  return (method: string): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      if (!input.pending()) return;
      yield* input.recheck.pipe(Effect.ignore);
      if (!input.pending()) return;
      return yield* new ProviderAdapterRequestError({
        provider: DRIVER_KIND,
        method,
        detail: unoCreditsChoiceRequiredText(input.harnessLabel),
      });
    });
}

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => Schema.decodeSync(ClaudeSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const eventLoggers = yield* ProviderEventLoggers;
      const browserBridge = yield* BrowserBridge;
      const unoAgentEnv = yield* (yield* UnoAgentAccess).environment();
      // Uno AI for Claude Code (no Claude sign-in of its own): the gateway key
      // is read once per instance — the registry rebuilds Claude when it
      // changes (ProviderInstanceRegistryHydration). Who Claude runs as is
      // decided by every status check and read per query.
      const unoGatewayKey = yield* (yield* UnoGatewayKey).harnessKey();
      const unoOverlay = unoGatewayKey.length > 0 ? unoClaudeEnvironment(unoGatewayKey) : null;
      // A trial computer (free chat) has no Claude on Uno AI: the gateway says so.
      const unoAvailable =
        unoGatewayKey.length > 0
          ? makeUnoClaudeAvailability({ baseUrl: UNO_GATEWAY_BASE_URL, key: unoGatewayKey })
          : null;
      let authMode: ClaudeAuthMode = "own";
      // Uno AI is paid from the account's credits: only once the person said
      // so on this machine (the chat asks — "Sign in / Use Uno credits").
      // Without it nothing runs on the gateway: turns are refused below and
      // text generation gets no gateway env.
      const serverSettings = yield* ServerSettingsService;
      let unoCreditsAllowed = yield* serverSettings.getSettings.pipe(
        Effect.map(claudeUnoCreditsAllowed),
        Effect.orElseSucceed(() => false),
      );
      yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
        Effect.sync(() => {
          unoCreditsAllowed = claudeUnoCreditsAllowed(settings);
        }),
      ).pipe(Effect.forkScoped);
      const authOverlay = (): Record<string, string> =>
        claudeAuthOverlay({ mode: authMode, unoOverlay, unoCreditsAllowed });
      const processEnv = {
        ...unoAgentEnv,
        ...browserBridge.applyEnvironment(mergeProviderInstanceEnvironment(environment)),
      };
      // One brief for every harness (agentContext/unoWorkBrief.md); the long
      // contracts are served on demand by the uno-work MCP server.
      const harnessInstructions = buildUnoWorkBrief();
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;

      // First start of this version: a machine where Claude Code already ran
      // on Uno credits keeps doing so (claudeUnoCreditsMigration.ts). Once per
      // machine, by the default instance; a turn meanwhile waits for it.
      const unoCreditsMigrated = yield* Deferred.make<void>();
      if (instanceId === defaultInstanceIdForDriver(DRIVER_KIND)) {
        yield* migrateUnoCreditsConsent({
          driver: DRIVER_KIND,
          getSettings: serverSettings.getSettings,
          updateSettings: serverSettings.updateSettings,
          ranOnUno: () =>
            claudeRanOnUnoGateway({
              configDir: claudeConfigDir({
                homePath: effectiveConfig.homePath,
                environment: processEnv,
              }),
            }),
        }).pipe(
          Effect.tap((result) =>
            Effect.gen(function* () {
              if (result === "allowed") unoCreditsAllowed = true;
              if (result !== "skipped") {
                yield* Effect.logInfo("Claude Code on Uno credits: first-start check", {
                  result,
                });
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Claude Code on Uno credits: first-start check failed", cause),
          ),
          Effect.ensuring(Deferred.succeed(unoCreditsMigrated, undefined)),
          Effect.forkScoped,
        );
      } else {
        yield* Deferred.succeed(unoCreditsMigrated, undefined);
      }
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const customMcpServers = yield* customMcpServersGetter;
      const adapterOptions = {
        instanceId,
        customMcpServers,
        environment: processEnv,
        bridgeEnvironment: (context: { readonly threadId?: string; readonly cwd?: string }) => ({
          ...browserBridge.scopedEnvironment(context),
          ...authOverlay(),
        }),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        ...(harnessInstructions ? { appendSystemPrompt: harnessInstructions } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        authOverlay,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      // (keyed by auth mode too: on Uno AI the probe runs with the gateway env).
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 2,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: (key: string) =>
          probeClaudeCapabilities(
            effectiveConfig,
            key.endsWith("\0uno") && unoOverlay !== null
              ? { ...processEnv, ...unoOverlay }
              : processEnv,
          ).pipe(Effect.provideService(Path.Path, path)),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig);

      // A probe that could not verify auth (typically: not signed in yet) is
      // not worth caching for the full TTL — the user may sign in from the
      // UI moments later and the explicit refresh that follows must see it.
      // The same for a probe that ran but found no account (Claude Code not
      // signed in yet): kept, it hid a sign-in for up to 5 minutes — the
      // refresh right after it still read "no plan", so Settings → AI asked
      // to sign in to Claude again (cap walkthrough 28.10, P3).
      const resolveCapabilities = (_settings: ClaudeSettings, mode: ClaudeAuthMode) => {
        const key = `${capabilitiesCacheKey}\0${mode}`;
        return Cache.get(capabilitiesProbeCache, key).pipe(
          Effect.tap((capabilities) =>
            capabilities === undefined ||
            (mode === "own" && !capabilitiesFoundAccount(capabilities))
              ? Cache.invalidate(capabilitiesProbeCache, key)
              : Effect.void,
          ),
        );
      };

      const checkProvider = checkClaudeProviderStatus(
        effectiveConfig,
        resolveCapabilities,
        processEnv,
        {
          environment: () => unoOverlay,
          setMode: (mode) => {
            authMode = mode;
          },
          ...(unoAvailable ? { available: () => Effect.promise(() => unoAvailable()) } : {}),
        },
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<ClaudeSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingClaudeProvider(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Not signed in, would run on Uno AI, and the person hasn't allowed Uno
      // credits here: refuse instead of spending them quietly. Every source
      // lands here — the composer (which asks first), Telegram / Slack, other
      // agents, schedules. A sign-in from a terminal is not seen until the
      // next 5-minute check, so look again before saying no.
      const requireUnoCreditsChoice = makeUnoCreditsGuard({
        pending: () => authMode === "uno" && unoOverlay !== null && !unoCreditsAllowed,
        recheck: Deferred.await(unoCreditsMigrated).pipe(
          Effect.timeoutOption(UNO_CREDITS_MIGRATION_WAIT),
          Effect.andThen(snapshot.refresh),
        ),
        harnessLabel: CLAUDE_CODE_LABEL,
      });
      const guardedAdapter: typeof adapter = {
        ...adapter,
        startSession: (input) =>
          requireUnoCreditsChoice("session/start").pipe(
            Effect.andThen(adapter.startSession(input)),
          ),
        sendTurn: (input) =>
          requireUnoCreditsChoice("turn/start").pipe(Effect.andThen(adapter.sendTurn(input))),
        get streamEvents() {
          return adapter.streamEvents;
        },
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: guardedAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
