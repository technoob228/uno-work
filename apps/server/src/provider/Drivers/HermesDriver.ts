/**
 * HermesDriver — `ProviderDriver` for the Hermes Agent (`hermes acp`) runtime.
 *
 * Hermes говорит стандартный ACP (protocolVersion 1), LLM ходит строго через
 * Uno Gateway: env `OPENAI_API_KEY` (= верхнеуровневый `uno.apiKey` настроек,
 * как у UnoDriver) + `OPENAI_BASE_URL` + `HERMES_INFERENCE_PROVIDER=openai-api`.
 * Состояние изолируется от пользовательского ~/.hermes через
 * `HERMES_HOME=<stateDir>/hermes-home-<instanceId>`.
 *
 * TextGeneration в v1 не поддержан — заглушка возвращает TextGenerationError,
 * коммиты/заголовки генерятся другими инстансами.
 *
 * @module provider/Drivers/HermesDriver
 */
import {
  AI_PROVIDER_LABELS,
  ASSISTANT_HARNESS_INSTANCE_ID,
  HermesSettings,
  ProviderDriverKind,
  TextGenerationError,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as os from "node:os";

import { ServerConfig } from "../../config.ts";
import { buildPluginInstructions } from "../../plugins/pluginInstructions.ts";
import { buildMachineAppsInstructions } from "../../machineApps/machineAppsInstructions.ts";
import { buildBrowserInstructions } from "../browserInstructions.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { UnoAgentAccess } from "../../unoAgentAccess.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import { AiProviderKeys } from "../../aiProviders/AiProviderKeys.ts";
import { gatewayBaseUrlForApp, isAppLabel } from "../../appSdk/appTaskLabel.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildHermesSpawnEnvironment,
  hermesAppLabelEnvironment,
  type HermesLlmRoute,
} from "../acp/HermesAcpSupport.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
} from "../Layers/HermesProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { withUserLocalBinOnPath } from "../setup/harnessProcess.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type HermesDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | UnoAgentAccess
  | UnoGatewayKey
  | AiProviderKeys
  | ServerConfig
  | ServerSettingsService;

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

const makeUnsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Text generation is not supported by the Hermes driver.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => Schema.decodeSync(HermesSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettingsService = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const browserBridge = yield* BrowserBridge;

      const serverSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      // Только ключ шлюза: ключ аккаунта в процесс харнесса не уходит.
      const gatewayKey = yield* UnoGatewayKey;
      const unoApiKey = yield* gatewayKey.harnessKey();
      const providerKeys = yield* AiProviderKeys;

      // Per-session LLM route (contracts: aiProviders.ts). The gateway key is
      // read fresh per session — on a Work box it often lands after start.
      const resolveLlmRoute = (input: {
        readonly threadId: string;
        readonly provider: HermesLlmRoute["provider"];
      }): Effect.Effect<HermesLlmRoute, string> =>
        Effect.gen(function* () {
          if (input.provider === "uno") {
            const apiKey = yield* gatewayKey.harnessKey();
            const label = gatewayKey.appOfThread(input.threadId);
            return {
              provider: "uno" as const,
              apiKey,
              baseUrl:
                label !== null && isAppLabel(label)
                  ? gatewayBaseUrlForApp(UNO_GATEWAY_BASE_URL, label)
                  : UNO_GATEWAY_BASE_URL,
            };
          }
          const stored = yield* providerKeys.resolve(input.provider);
          if (stored === null) {
            return yield* Effect.fail(
              `No ${AI_PROVIDER_LABELS[input.provider]} key on this computer. Add it in Settings → Agents → AI provider keys, or switch Uno to the Uno gateway.`,
            );
          }
          return { provider: input.provider, apiKey: stored.apiKey, baseUrl: stored.baseUrl };
        });

      const hermesEnvironment = buildHermesSpawnEnvironment({
        unoApiKey,
        hermesHome: path.join(serverConfig.stateDir, `hermes-home-${instanceId}`),
      });
      const unoAgentEnv = yield* (yield* UnoAgentAccess).environment();
      const harnessInstructions = [
        buildBrowserInstructions(browserBridge.baseUrl),
        buildPluginInstructions(serverConfig.pluginsDir),
        buildMachineAppsInstructions(),
      ]
        .filter((block): block is string => block !== undefined && block.length > 0)
        .join("\n\n");
      const processEnv = {
        ...unoAgentEnv,
        // `uv tool install` puts hermes into ~/.local/bin, which a desktop
        // app's PATH often lacks — the daemon's own first-use install would
        // otherwise leave a hermes it cannot find.
        ...browserBridge.applyEnvironment(
          withUserLocalBinOnPath(mergeProviderInstanceEnvironment(environment), os.homedir()),
        ),
        ...hermesEnvironment,
        // Hermes' embedder slot: appended to the stable system prompt (env wins
        // over config `agent.environment_hint`). No other system-prompt hook
        // exists in `hermes acp`.
        ...(harnessInstructions.length > 0 ? { HERMES_ENVIRONMENT_HINT: harnessInstructions } : {}),
      };

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      // The default Hermes instance is the Uno assistant's harness (0.0.84):
      // it can always run a session, whether or not the person turned Hermes
      // on for other chats. `providers.hermes.enabled` keeps meaning "offer
      // Hermes in the pickers" — that is the snapshot's `enabled`; the probe
      // runs either way, so the assistant knows whether Hermes is installed.
      const servesAssistant = instanceId === ASSISTANT_HARNESS_INSTANCE_ID;
      const runnable = servesAssistant ? true : enabled;
      const effectiveConfig = { ...config, enabled: runnable } satisfies HermesSettings;
      const offeredInPickers = enabled;
      const withPickerVisibility = (snapshot: ServerProvider): ServerProvider =>
        offeredInPickers || !servesAssistant
          ? snapshot
          : {
              ...snapshot,
              enabled: false,
              status: "disabled",
              ...(snapshot.installed
                ? {
                    message:
                      "Runs Uno, your assistant. Turn on to offer Hermes in other chats too.",
                  }
                : {}),
            };

      const adapter = yield* makeHermesAdapter(effectiveConfig, {
        environment: processEnv,
        bridgeEnvironment: (context) => ({
          ...browserBridge.scopedEnvironment(context),
          // Задача приложения машины (Uno App SDK): вызовы шлюза с меткой
          // приложения. OpenAI SDK Hermes'а не берёт заголовки из env —
          // метка в base URL (`/v1/apps/<id>`, шлюз обслуживает те же ручки).
          ...hermesAppLabelEnvironment(gatewayKey.appOfThread(context.threadId)),
        }),
        resolveLlmRoute,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });

      const checkProvider = checkHermesProviderStatus(effectiveConfig, unoApiKey, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.map(withPickerVisibility),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<HermesSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          withPickerVisibility(stampIdentity(buildInitialHermesProviderSnapshot(settings))),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Hermes snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: runnable,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
