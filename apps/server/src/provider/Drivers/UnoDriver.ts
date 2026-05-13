/**
 * UnoDriver — first-party Uno harness driver.
 *
 * Talks to the same `uno-code` runtime as `OpenCodeDriver` (a rebrand fork of
 * sst/opencode lives in ~/uno-project/uno-code/), so it reuses
 * `OpenCodeAdapter`, `OpenCodeProvider` and `OpenCodeRuntime` — the only
 * differences are:
 *
 *   - `driverKind = "uno"` and `displayName = "Uno"` so the provider shows up
 *     as a separate entry in the picker alongside Codex / Claude / Cursor /
 *     OpenCode;
 *   - the binary path is pinned to the silently-installed
 *     `~/.unowork/uno-code/bin/uno-code` (or `.exe` on Windows). Whatever the
 *     instance config stores for `binaryPath` is ignored — Uno is supposed to
 *     "just work" without the user picking a binary;
 *   - the Uno LLM Gateway provider (`provider.uno` pointing at
 *     `UNO_GATEWAY_BASE_URL` with `apiKey={env:UNO_API_KEY}`) is injected via
 *     `OPENCODE_CONFIG_CONTENT`, and `UNO_API_KEY` is set from the stored
 *     `uno.apiKey` server setting. Because our fork resolves XDG to
 *     `~/.config/uno-code/` (not `~/.config/opencode/`), this config does NOT
 *     merge with the user's personal opencode config.
 *
 * @module provider/Drivers/UnoDriver
 */
import { homedir } from "node:os";
import * as nodePath from "node:path";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  UNO_GATEWAY_BASE_URL,
  type ServerProvider,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("uno");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type UnoDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const UNO_PROVIDER_ID = "uno";

const UNO_BINARY_PATH = nodePath.join(
  homedir(),
  ".unowork",
  "uno-code",
  "bin",
  process.platform === "win32" ? "uno-code.exe" : "uno-code",
);

function buildUnoConfigContent(unoApiKey: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [UNO_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Uno",
        options: {
          baseURL: UNO_GATEWAY_BASE_URL,
          apiKey: "{env:UNO_API_KEY}",
        },
      },
    },
  });
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

export const UnoDriver: ProviderDriver<OpenCodeSettings, UnoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Uno",
    supportsMultipleInstances: false,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => Schema.decodeSync(OpenCodeSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const serverSettingsService = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const unoApiKey = serverSettings?.uno.apiKey ?? "";
      const baseProcessEnv = mergeProviderInstanceEnvironment(environment);
      const processEnv: NodeJS.ProcessEnv = {
        ...baseProcessEnv,
        OPENCODE_CONFIG_CONTENT: buildUnoConfigContent(unoApiKey),
        ...(unoApiKey.length > 0 ? { UNO_API_KEY: unoApiKey } : {}),
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
      const effectiveConfig = {
        ...config,
        binaryPath: UNO_BINARY_PATH,
        enabled,
      } satisfies OpenCodeSettings;

      const adapter = yield* makeOpenCodeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingOpenCodeProvider(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Uno snapshot: ${cause.message ?? String(cause)}`,
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
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
