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
  ProviderDriverKind,
  UNO_GATEWAY_BASE_URL,
  type ServerProvider,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { UnoAgentAccess } from "../../unoAgentAccess.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import { buildUnoWorkBrief } from "../../agentContext/unoWorkBrief.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { customMcpServersGetter } from "../../mcp/customMcpServers.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  type ClaudeAuthMode,
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
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
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

export type ClaudeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | UnoAgentAccess
  | UnoGatewayKey
  | ServerConfig;

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
      let authMode: ClaudeAuthMode = "own";
      const authOverlay = (): Record<string, string> =>
        authMode === "uno" && unoOverlay !== null ? unoOverlay : {};
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
      const resolveCapabilities = (_settings: ClaudeSettings, mode: ClaudeAuthMode) => {
        const key = `${capabilitiesCacheKey}\0${mode}`;
        return Cache.get(capabilitiesProbeCache, key).pipe(
          Effect.tap((capabilities) =>
            capabilities === undefined
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
