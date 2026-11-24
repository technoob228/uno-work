/**
 * GrokDriver — `ProviderDriver` for xAI's Grok CLI (`grok agent stdio`).
 *
 * Built in like Gemini CLI: on when `grok` is on PATH (or at the path in
 * Settings → AI), signed in with an xAI account (`grok login`) or
 * `XAI_API_KEY` (Settings → AI → Grok → API key stores it in this
 * instance's environment). The session runs on the shared ACP adapter with
 * the same per-thread sessions, approvals, reaper and picker as the other
 * ACP agents.
 *
 * Environment of the Grok process: the daemon's with Uno secrets stripped,
 * the instance's own variables, the browser bridge, `UNO_WORK_*`, and
 * `GROK_DISABLE_AUTOUPDATER` (GrokAcpSupport).
 *
 * @module provider/Drivers/GrokDriver
 */
import {
  GrokSettings,
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildUnoWorkBrief } from "../../agentContext/unoWorkBrief.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { ServerConfig } from "../../config.ts";
import {
  acpMcpServers,
  customMcpServersGetter,
  sessionMcpServers,
} from "../../mcp/customMcpServers.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { harnessPath } from "../acp/CustomAcpSupport.ts";
import { GROK_DISPLAY_NAME, GROK_DRIVER_KIND, GROK_PROCESS_ENV } from "../acp/GrokAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { buildInitialGrokSnapshot, checkGrokProviderStatus } from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make(GROK_DRIVER_KIND);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type GrokDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | ServerConfig;

/**
 * Titles and commit messages come from another agent: a one-shot `grok -p`
 * per title would start a whole CLI (and its MCP servers) each time.
 */
const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Text generation is not supported by Grok in Uno Work.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: GROK_DISPLAY_NAME,
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => Schema.decodeSync(GrokSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const browserBridge = yield* BrowserBridge;
      const customMcpServers = yield* customMcpServersGetter;
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const name = displayName?.trim() || GROK_DISPLAY_NAME;
      const harnessInstructions = buildUnoWorkBrief();
      const baseEnvironment = browserBridge.applyEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const processEnv: NodeJS.ProcessEnv = {
        ...baseEnvironment,
        PATH: harnessPath(baseEnvironment),
        ...GROK_PROCESS_ENV,
      };

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });

      // The installed CLI's own model list, from its latest session.
      let discoveredModels: ReadonlyArray<{ readonly id: string; readonly name: string }> = [];
      let refreshSnapshot: (() => void) | undefined;

      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        instanceId,
        displayName: name,
        environment: processEnv,
        bridgeEnvironment: (context) => browserBridge.scopedEnvironment(context),
        ...(harnessInstructions.length > 0 ? { harnessInstructions } : {}),
        // This chat's MCP servers, like every other agent: built-in uno-work
        // (its own bridge token) + the owner's settings.mcpServers.
        extraMcpServers: (context) =>
          acpMcpServers(
            sessionMcpServers({
              bridgeEnvironment: browserBridge.scopedEnvironment(context),
              custom: customMcpServers({ threadId: context.threadId }),
            }),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onModelsDiscovered: (discovered) => {
          if (JSON.stringify(discovered.models) === JSON.stringify(discoveredModels)) return;
          discoveredModels = discovered.models;
          refreshSnapshot?.();
        },
      });

      const checkProvider = checkGrokProviderStatus({
        config: effectiveConfig,
        environment: processEnv,
        discoveredModels: () => discoveredModels,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<GrokSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialGrokSnapshot(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Grok snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      refreshSnapshot = () => {
        Effect.runFork(snapshot.refresh.pipe(Effect.ignore));
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
