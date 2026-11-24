/**
 * AntigravityDriver — `ProviderDriver` for Google Antigravity through its
 * official ACP agent (`agy acp`), Gemini's recommended path in Uno Work.
 * Ported from upstream T3 Code (pingdotgg/t3code #9348, MIT) onto Uno Work's
 * shared ACP adapter.
 *
 * Built in like Gemini CLI and Grok: on when `agy` is found (Settings → AI
 * path, the CLI Uno Work installed, or the computer's own) and Antigravity
 * is signed in on this computer — with a Google account (`agy acp --login`,
 * or the Antigravity app / CLI already signed in) or a Gemini API key stored
 * in this instance's environment (`ANTIGRAVITY_GEMINI_API_KEY`).
 *
 * One instance: it uses the computer's own Antigravity profile, so a second
 * instance would be the same account (upstream gives each its own profile).
 *
 * @module provider/Drivers/AntigravityDriver
 */
import {
  AntigravitySettings,
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../../package.json" with { type: "json" };
import { buildUnoWorkBrief } from "../../agentContext/unoWorkBrief.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { ServerConfig } from "../../config.ts";
import {
  acpMcpServers,
  customMcpServersGetter,
  sessionMcpServers,
} from "../../mcp/customMcpServers.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ANTIGRAVITY_DISPLAY_NAME, ANTIGRAVITY_DRIVER_KIND } from "../acp/AntigravityAcpSupport.ts";
import { harnessPath } from "../acp/CustomAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityAdapter } from "../Layers/AntigravityAdapter.ts";
import {
  type AntigravityObservedModels,
  buildInitialAntigravitySnapshot,
  checkAntigravityStatus,
  observeAntigravityConfig,
  probeAntigravityConfigOptions,
} from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make(ANTIGRAVITY_DRIVER_KIND);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type AntigravityDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | ServerConfig;

/** Titles and commit messages come from another agent (upstream has an Antigravity one; not ported). */
const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Text generation is not supported by Antigravity in Uno Work.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: ANTIGRAVITY_DISPLAY_NAME,
    supportsMultipleInstances: false,
  },
  configSchema: AntigravitySettings,
  defaultConfig: (): AntigravitySettings => Schema.decodeSync(AntigravitySettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const browserBridge = yield* BrowserBridge;
      const customMcpServers = yield* customMcpServersGetter;
      const effectiveConfig = { ...config, enabled } satisfies AntigravitySettings;
      const name = displayName?.trim() || ANTIGRAVITY_DISPLAY_NAME;
      const harnessInstructions = buildUnoWorkBrief();
      const baseEnvironment = browserBridge.applyEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const processEnv: NodeJS.ProcessEnv = {
        ...baseEnvironment,
        PATH: harnessPath(baseEnvironment),
      };
      const clientVersion = packageJson.version;

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

      // This account's models and thinking levels, as the runtime last listed them.
      let observed: AntigravityObservedModels | undefined;
      let probedExecutable: string | undefined;
      let refreshSnapshot: (() => void) | undefined;
      const observe = (configOptions: Parameters<typeof observeAntigravityConfig>[1]) => {
        const next = observeAntigravityConfig(observed, configOptions);
        if (!next) return;
        const changed =
          JSON.stringify(next.configOptions) !== JSON.stringify(observed?.configOptions) ||
          next.thinking.size !== observed?.thinking.size;
        observed = next;
        if (changed) refreshSnapshot?.();
      };

      const adapter = yield* makeAntigravityAdapter(effectiveConfig, {
        instanceId,
        displayName: name,
        environment: processEnv,
        clientVersion,
        bridgeEnvironment: (context) => browserBridge.scopedEnvironment(context),
        ...(harnessInstructions.length > 0 ? { harnessInstructions } : {}),
        extraMcpServers: (context) =>
          acpMcpServers(
            sessionMcpServers({
              bridgeEnvironment: browserBridge.scopedEnvironment(context),
              custom: customMcpServers({ threadId: context.threadId }),
            }),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onConfigOptions: observe,
      });

      const checkProvider = Effect.promise(async () => {
        const status = await checkAntigravityStatus({
          config: effectiveConfig,
          environment: processEnv,
          observed,
        });
        // Signed in and no chat yet: learn the models once from a short session.
        if (
          observed === undefined &&
          status.executable !== undefined &&
          status.auth?.status === "authenticated" &&
          status.snapshot.status === "ready" &&
          probedExecutable !== status.executable
        ) {
          probedExecutable = status.executable;
          void probeAntigravityConfigOptions({
            executable: status.executable,
            version: status.version,
            environment: processEnv,
            clientVersion,
          }).then((configOptions) => {
            if (configOptions) observe(configOptions);
          });
        }
        return stampIdentity(status.snapshot);
      });

      const snapshot = yield* makeManagedServerProvider<AntigravitySettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialAntigravitySnapshot(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Antigravity snapshot: ${cause.message ?? String(cause)}`,
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
