/**
 * CustomHarnessDriver — `ProviderDriver` for custom harnesses: any agent that
 * speaks the Agent Client Protocol over stdio (docs/custom-harness.md).
 *
 * One driver kind (`acp`), any number of instances — each a harness the
 * person added in Settings → Harnesses or an AI registered as
 * `~/.uno/harnesses/<id>.json`. Same per-thread sessions, permission modes,
 * reaper and picker as the built-in agents.
 *
 * Environment of the agent process:
 *   - the daemon's environment with Uno secrets stripped, plus the harness's
 *     own variables (secret ones come from the secret store);
 *   - always: `UNO_WORK=1`, `UNO_WORK_THREAD_ID`, `UNO_WORK_PROJECT_DIR`,
 *     `UNO_WORK_HARNESS_ID`, `UNO_WORK_BRIEF_FILE` (what every Uno Work agent
 *     is told about this machine), `UNO_WORK_HARNESS_GUIDE`, and the browser
 *     bridge `UNO_WORK_BRIDGE_URL`/`UNO_WORK_BRIDGE_TOKEN` (scoped to the chat);
 *   - only when the person allowed it: `UNO_GATEWAY_API_KEY` +
 *     `UNO_GATEWAY_BASE_URL` (the account's AI gateway) and the machine's Uno
 *     identity (`UNO_AGENT_API_KEY`, `UNO_API_URL`, `UNO_BOX_ID`).
 *
 * @module provider/Drivers/CustomHarnessDriver
 */
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  CUSTOM_HARNESS_DRIVER_KIND,
  CustomHarnessSettings,
  ProviderDriverKind,
  TextGenerationError,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { BrowserBridge } from "../../browserBridge.ts";
import {
  acpMcpServers,
  customMcpServersGetter,
  sessionMcpServers,
} from "../../mcp/customMcpServers.ts";
import { buildUnoWorkBrief } from "../../agentContext/unoWorkBrief.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { UnoAgentAccess } from "../../unoAgentAccess.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import { harnessPath } from "../acp/CustomAcpSupport.ts";
import { resolveHarnessGuidePath } from "../customHarness/harnessGuide.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCustomHarnessAdapter } from "../Layers/CustomHarnessAdapter.ts";
import {
  buildInitialCustomHarnessSnapshot,
  checkCustomHarnessStatus,
} from "../Layers/CustomHarnessProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make(CUSTOM_HARNESS_DRIVER_KIND);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type CustomHarnessDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | UnoAgentAccess
  | UnoGatewayKey
  | ServerConfig
  | ServerSettingsService;

const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Text generation is not supported by custom harnesses.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

/**
 * The environment brief every Uno Work agent gets, as a file: ACP has no
 * system-prompt slot, so a custom agent reads `$UNO_WORK_BRIEF_FILE` if it
 * wants to know about the machine (apps, browser, plugins).
 */
async function writeBriefFile(stateDir: string, brief: string): Promise<string> {
  const file = nodePath.join(stateDir, "custom-harness", "environment-brief.md");
  await mkdir(nodePath.dirname(file), { recursive: true });
  await writeFile(file, `${brief}\n`, { mode: 0o644 });
  return file;
}

export const CustomHarnessDriver: ProviderDriver<CustomHarnessSettings, CustomHarnessDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Custom harness",
    supportsMultipleInstances: true,
  },
  configSchema: CustomHarnessSettings,
  defaultConfig: (): CustomHarnessSettings => Schema.decodeSync(CustomHarnessSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const browserBridge = yield* BrowserBridge;
      const gatewayKey = yield* UnoGatewayKey;
      const customMcpServers = yield* customMcpServersGetter;
      const name = displayName?.trim() || config.command || String(instanceId);
      const effectiveConfig = { ...config, enabled } satisfies CustomHarnessSettings;

      // The same environment brief every harness gets (agentContext/unoWorkBrief.md).
      const brief = buildUnoWorkBrief();
      const briefFile = yield* Effect.promise(() =>
        writeBriefFile(serverConfig.stateDir, brief),
      ).pipe(Effect.orElseSucceed(() => undefined));

      const unoAccountEnv = effectiveConfig.shareUnoAccount
        ? yield* (yield* UnoAgentAccess).environment()
        : {};
      const gatewayApiKey = effectiveConfig.shareUnoGateway ? yield* gatewayKey.harnessKey() : "";
      const baseEnvironment = browserBridge.applyEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const processEnv: NodeJS.ProcessEnv = {
        ...baseEnvironment,
        PATH: harnessPath(baseEnvironment),
        ...unoAccountEnv,
        ...(gatewayApiKey
          ? { UNO_GATEWAY_API_KEY: gatewayApiKey, UNO_GATEWAY_BASE_URL: UNO_GATEWAY_BASE_URL }
          : {}),
        ...(briefFile ? { UNO_WORK_BRIEF_FILE: briefFile } : {}),
        UNO_WORK_HARNESS_GUIDE: resolveHarnessGuidePath(),
      };

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        displayName: name,
        ...(accentColor ? { accentColor } : {}),
        ...(effectiveConfig.icon.trim() ? { iconText: effectiveConfig.icon.trim() } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });

      // Models the agent advertised in its latest session (when the config
      // lists none); the snapshot refreshes to pick them up.
      let discoveredModels: ReadonlyArray<{ readonly id: string; readonly name: string }> = [];
      let refreshSnapshot: (() => void) | undefined;

      const adapter = yield* makeCustomHarnessAdapter(effectiveConfig, {
        instanceId,
        displayName: name,
        environment: processEnv,
        bridgeEnvironment: (context) => browserBridge.scopedEnvironment(context),
        harnessInstructions: brief,
        // This chat's MCP servers, like every other agent: built-in uno-work
        // (its own bridge token) + the owner's settings.mcpServers.
        extraMcpServers: (context) =>
          acpMcpServers(
            sessionMcpServers({
              bridgeEnvironment: browserBridge.scopedEnvironment(context),
              custom: customMcpServers(),
            }),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onModelsDiscovered: (discovered) => {
          if (JSON.stringify(discovered.models) === JSON.stringify(discoveredModels)) return;
          discoveredModels = discovered.models;
          if (effectiveConfig.models.length === 0) refreshSnapshot?.();
        },
      });

      const checkProvider = checkCustomHarnessStatus({
        config: effectiveConfig,
        displayName: name,
        environment: processEnv,
        discoveredModels: () => discoveredModels,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<CustomHarnessSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          stampIdentity(buildInitialCustomHarnessSnapshot(settings, { displayName: name })),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build custom harness snapshot: ${cause.message ?? String(cause)}`,
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
        displayName: name,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
