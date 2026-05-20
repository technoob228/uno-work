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

type UnoModelTier = "frontier" | "strong" | "cheap";

const TIER_RANK: Record<UnoModelTier, number> = {
  frontier: 0,
  strong: 1,
  cheap: 2,
};

// Headline models pinned to the top of the picker in this exact order,
// regardless of tier. Update when the Gateway ships a new flagship from
// any of these vendors so the user keeps seeing the latest by default.
const PINNED_MODEL_IDS = [
  "anthropic/claude-opus-4.7",
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "moonshotai/kimi-k2.6",
  "deepseek/deepseek-v4-pro",
] as const;

const PINNED_RANK = new Map<string, number>(PINNED_MODEL_IDS.map((id, idx) => [id, idx]));

interface UnoCatalogModel {
  readonly name: string;
  readonly tier: UnoModelTier;
}

type UnoCatalog = Record<string, UnoCatalogModel>;

interface UnoGatewayModelResponse {
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly tier?: unknown;
}

async function fetchUnoModelsCatalog(unoApiKey: string): Promise<UnoCatalog> {
  if (unoApiKey.length === 0) return {};
  try {
    const response = await fetch(`${UNO_GATEWAY_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${unoApiKey}` },
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as { readonly data?: ReadonlyArray<UnoGatewayModelResponse> };
    const catalog: Record<string, UnoCatalogModel> = {};
    for (const entry of payload.data ?? []) {
      if (typeof entry.id !== "string" || entry.id.length === 0) continue;
      const name =
        typeof entry.display_name === "string" && entry.display_name.length > 0
          ? entry.display_name
          : entry.id;
      const tier: UnoModelTier =
        entry.tier === "frontier" || entry.tier === "strong" ? entry.tier : "cheap";
      catalog[entry.id] = { name, tier };
    }
    return catalog;
  } catch {
    return {};
  }
}

function buildUnoConfigContent(unoApiKey: string, models: UnoCatalog): string {
  // opencode's config schema only accepts `{ name }`-shaped model entries;
  // strip the local tier metadata before injecting via OPENCODE_CONFIG_CONTENT.
  const opencodeModels: Record<string, { readonly name: string }> = {};
  for (const [id, model] of Object.entries(models)) {
    opencodeModels[id] = { name: model.name };
  }
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
        models: opencodeModels,
      },
    },
  });
}

const UNO_DEFAULT_DISPLAY_NAME = "Uno";

const filterUnoModels = (snapshot: ServerProviderDraft): ServerProviderDraft => ({
  ...snapshot,
  // Drop opencode-zen models AND strip `subProvider` from our own rows.
  // Both `provider.uno.name` (subProvider source) and `displayName` resolve
  // to "Uno", so leaving subProvider in place renders as "Uno · Uno" in
  // the picker trigger and combobox row.
  models: snapshot.models
    .filter((model) => model.slug.startsWith(`${UNO_PROVIDER_ID}/`))
    .map(({ subProvider: _drop, ...rest }) => rest),
});

const stripUnoPrefix = (slug: string): string =>
  slug.startsWith(`${UNO_PROVIDER_ID}/`) ? slug.slice(UNO_PROVIDER_ID.length + 1) : slug;

const sortUnoModels =
  (catalog: UnoCatalog) =>
  (snapshot: ServerProviderDraft): ServerProviderDraft => ({
    ...snapshot,
    models: [...snapshot.models].sort((a, b) => {
      const aId = stripUnoPrefix(a.slug);
      const bId = stripUnoPrefix(b.slug);

      const aPinned = PINNED_RANK.get(aId);
      const bPinned = PINNED_RANK.get(bId);
      if (aPinned !== undefined && bPinned !== undefined) return aPinned - bPinned;
      if (aPinned !== undefined) return -1;
      if (bPinned !== undefined) return 1;

      const aTier = catalog[aId]?.tier ?? "cheap";
      const bTier = catalog[bId]?.tier ?? "cheap";
      const tierDiff = TIER_RANK[aTier] - TIER_RANK[bTier];
      if (tierDiff !== 0) return tierDiff;

      return aId.localeCompare(bId);
    }),
  });

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
    displayName: input.displayName?.trim() || UNO_DEFAULT_DISPLAY_NAME,
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
      const unoCatalog = yield* Effect.promise(() => fetchUnoModelsCatalog(unoApiKey));
      const baseProcessEnv = mergeProviderInstanceEnvironment(environment);
      const processEnv: NodeJS.ProcessEnv = {
        ...baseProcessEnv,
        OPENCODE_CONFIG_CONTENT: buildUnoConfigContent(unoApiKey, unoCatalog),
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

      const sortByCatalog = sortUnoModels(unoCatalog);

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(
        Effect.map(filterUnoModels),
        Effect.map(sortByCatalog),
        Effect.map(stampIdentity),
        Effect.provideService(OpenCodeRuntime, openCodeRuntime),
      );

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          stampIdentity(sortByCatalog(filterUnoModels(makePendingOpenCodeProvider(settings)))),
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
