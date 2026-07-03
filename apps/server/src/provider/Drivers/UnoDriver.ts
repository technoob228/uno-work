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
 *   - the binary path defaults to the silently-installed
 *     `~/.unowork/uno-code/bin/uno-code` (or `.exe` on Windows) when the
 *     instance config leaves `binaryPath` blank. A user can still point at a
 *     custom binary via Settings — important for the bring-your-own-binary
 *     fallback when the GitHub release for the current version is missing;
 *   - the Uno LLM Gateway provider (`provider.uno` pointing at
 *     `UNO_GATEWAY_BASE_URL` with `apiKey={env:UNO_API_KEY}`) is injected via
 *     `OPENCODE_CONFIG_CONTENT`, and `UNO_API_KEY` is set from the stored
 *     `uno.apiKey` server setting. Because our fork resolves XDG to
 *     `~/.config/uno-code/` (not `~/.config/opencode/`), this config does NOT
 *     merge with the user's personal opencode config.
 *
 * @module provider/Drivers/UnoDriver
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  UNO_CODE_MINIMUM_VERSION,
  UNO_GATEWAY_BASE_URL,
  type ModelCapabilitiesMetadata,
  type ServerProvider,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import { writeBrowserInstructionsFile } from "../browserInstructions.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
  type ProviderPresentation,
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

const UNO_PRESENTATION: ProviderPresentation = {
  displayName: "Uno",
  binaryCommand: "uno-code",
  minimumVersion: UNO_CODE_MINIMUM_VERSION,
  showInteractionModeToggle: true,
} as const;

export type UnoDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | BrowserBridge
  | ServerConfig
  | ServerSettingsService;

const UNO_PROVIDER_ID = "uno";
const UNO_RUSSIA_PROVIDER_ID = "uno-russia";
const UNO_RUSSIA_GATEWAY_BASE_URL = `${UNO_GATEWAY_BASE_URL}/russia`;
const UNO_IMAGE_GENERATION_AGENT_ID = "uno-image-generation";

const UNO_BINARY_PATH = nodePath.join(
  homedir(),
  ".unowork",
  "uno-code",
  "bin",
  process.platform === "win32" ? "uno-code.exe" : "uno-code",
);

export type UnoModelTier = "frontier" | "strong" | "cheap";
export type UnoModelRoute = "default" | "russia";

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

export interface UnoCatalogModel {
  readonly name: string;
  readonly tier: UnoModelTier;
  readonly modelId: string;
  readonly route: UnoModelRoute;
  readonly availableRoutes: ReadonlyArray<UnoModelRoute>;
  readonly provider: string;
  readonly contextLength: number | undefined;
  readonly supportsStreaming: boolean | undefined;
  readonly supportsTools: boolean | undefined;
  readonly supportsVision: boolean | undefined;
  readonly supportsImageOutput: boolean | undefined;
  readonly inputModalities: ReadonlyArray<string> | undefined;
  readonly outputModalities: ReadonlyArray<string> | undefined;
  readonly pricingKnown: boolean | undefined;
  readonly pricing: {
    readonly promptPer1MUsd: number | undefined;
    readonly completionPer1MUsd: number | undefined;
    readonly blendedPer1MUsd: number | undefined;
    readonly estimatedSeriousTaskUsd: number | undefined;
  };
}

type UnoCatalog = Record<string, UnoCatalogModel>;

const UNO_DEFAULT_MODEL_OPTIONS = {
  // The Uno Gateway can expose upstream reasoning by default for some models.
  // Keep chat output answer-only unless the user explicitly selects a reasoning
  // variant that overrides this option.
  reasoningEffort: "none",
} as const;

type UnoOpenCodeModelConfig = {
  readonly name: string;
  readonly options?: typeof UNO_DEFAULT_MODEL_OPTIONS;
};

function shouldOmitDefaultReasoningDisable(model: UnoCatalogModel): boolean {
  const modelId = model.modelId.toLowerCase();
  const name = model.name.toLowerCase();
  const provider = model.provider.toLowerCase();
  const searchable = `${provider}/${modelId} ${name}`;

  return (
    provider === "moonshotai" ||
    searchable.includes("kimi") ||
    searchable.includes("thinking") ||
    searchable.includes("reasoning") ||
    searchable.includes("minimax-m2") ||
    searchable.includes("step-3.5") ||
    // Fable 5 is reasoning-mandatory: the upstream rejects `reasoning: none`
    // with a "reasoning required" error, so never force the default disable.
    searchable.includes("fable") ||
    /qwen3.*thinking/u.test(searchable) ||
    /gemini-3(?:[._/ -]|$)/u.test(searchable)
  );
}

function defaultModelOptionsForUnoModel(
  model: UnoCatalogModel,
): typeof UNO_DEFAULT_MODEL_OPTIONS | undefined {
  return shouldOmitDefaultReasoningDisable(model) ? undefined : UNO_DEFAULT_MODEL_OPTIONS;
}

export interface UnoGatewayModelResponse {
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly owned_by?: unknown;
  readonly tier?: unknown;
  readonly context_length?: unknown;
  readonly supports_streaming?: unknown;
  readonly supports_tools?: unknown;
  readonly supports_vision?: unknown;
  readonly supports_image_input?: unknown;
  readonly supports_image_output?: unknown;
  readonly supports_image_generation?: unknown;
  readonly supports_images?: unknown;
  readonly supports_attachments?: unknown;
  readonly input_modalities?: unknown;
  readonly output_modalities?: unknown;
  readonly inputModalities?: unknown;
  readonly outputModalities?: unknown;
  readonly modalities?: unknown;
  readonly pricing_known?: unknown;
  readonly pricing?: unknown;
}

function parsePricePer1M(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed * 1_000_000;
}

function extractProvider(modelId: string, ownedBy: unknown): string {
  if (modelId.includes("/")) {
    return modelId.split("/")[0] ?? "unknown";
  }
  return typeof ownedBy === "string" && ownedBy.trim().length > 0 ? ownedBy.trim() : "unknown";
}

function parseGatewayBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function parseFirstGatewayBoolean(...values: ReadonlyArray<unknown>): boolean | undefined {
  for (const value of values) {
    const parsed = parseGatewayBoolean(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizeGatewayModality(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (!normalized) return null;
  if (
    normalized === "images" ||
    normalized === "image-url" ||
    normalized === "input-image" ||
    normalized === "output-image" ||
    normalized === "vision"
  ) {
    return "image";
  }
  if (normalized === "input-text" || normalized === "output-text") return "text";
  return normalized;
}

function parseGatewayModalityList(value: unknown): ReadonlyArray<string> | undefined {
  const rawValues =
    typeof value === "string"
      ? value.includes(",")
        ? value.split(",")
        : [value]
      : Array.isArray(value)
        ? value
        : [];
  const modalities = new Set<string>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") continue;
    const normalized = normalizeGatewayModality(rawValue);
    if (normalized) modalities.add(normalized);
  }
  return modalities.size > 0 ? [...modalities] : undefined;
}

function parseGatewayModalities(entry: UnoGatewayModelResponse): {
  readonly input: ReadonlyArray<string> | undefined;
  readonly output: ReadonlyArray<string> | undefined;
} {
  const nested =
    entry.modalities && typeof entry.modalities === "object" && !Array.isArray(entry.modalities)
      ? (entry.modalities as Record<string, unknown>)
      : undefined;
  return {
    input:
      parseGatewayModalityList(entry.input_modalities) ??
      parseGatewayModalityList(entry.inputModalities) ??
      parseGatewayModalityList(nested?.input) ??
      parseGatewayModalityList(nested?.input_modalities) ??
      parseGatewayModalityList(nested?.inputModalities),
    output:
      parseGatewayModalityList(entry.output_modalities) ??
      parseGatewayModalityList(entry.outputModalities) ??
      parseGatewayModalityList(nested?.output) ??
      parseGatewayModalityList(nested?.output_modalities) ??
      parseGatewayModalityList(nested?.outputModalities),
  };
}

function modalitiesIncludeImage(values: ReadonlyArray<string> | undefined): boolean {
  return values?.some((value) => value.toLowerCase() === "image") === true;
}

function inferKnownImageInputSupport(
  modelId: string,
  name: string,
  provider: string,
): boolean | undefined {
  const haystack = `${modelId} ${name} ${provider}`.toLowerCase();
  if (
    /\b(?:gpt-4o|gpt-5|o3|o4|gemini|claude|llava|pixtral)\b/.test(haystack) ||
    /(?:^|[/:_-])(?:vl|vision)(?:$|[/:_-])/.test(haystack) ||
    /qwen.*(?:vl|vision)/.test(haystack)
  ) {
    return true;
  }
  return undefined;
}

function inferKnownImageOutputSupport(
  modelId: string,
  name: string,
  provider: string,
): boolean | undefined {
  const haystack = `${modelId} ${name} ${provider}`.toLowerCase();
  if (
    /(?:gpt-image|gpt-[\w.]+[-_ ]image|dall[-_ ]?e|imagen|gemini.*image|nano[-_ ]?banana|flux|stable[-_ ]?diffusion|sdxl|recraft|ideogram|seedream|image[-_ ]?gen|image[-_ ]?generation|image[-_ ]?preview)/.test(
      haystack,
    )
  ) {
    return true;
  }
  return undefined;
}

export function normalizeUnoCatalogEntry(
  route: UnoModelRoute,
  entry: UnoGatewayModelResponse,
): UnoCatalogModel | undefined {
  if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
  const name =
    typeof entry.display_name === "string" && entry.display_name.length > 0
      ? entry.display_name
      : entry.id;
  const tier: UnoModelTier =
    entry.tier === "frontier" || entry.tier === "strong" ? entry.tier : "cheap";
  const provider = extractProvider(entry.id, entry.owned_by);
  const modalities = parseGatewayModalities(entry);
  const explicitImageInput = parseFirstGatewayBoolean(
    entry.supports_vision,
    entry.supports_image_input,
    entry.supports_images,
    entry.supports_attachments,
  );
  const supportsImageInput = modalitiesIncludeImage(modalities.input)
    ? true
    : (explicitImageInput ?? inferKnownImageInputSupport(entry.id, name, provider));
  const explicitImageOutput = parseFirstGatewayBoolean(
    entry.supports_image_output,
    entry.supports_image_generation,
  );
  const supportsImageOutput = modalitiesIncludeImage(modalities.output)
    ? true
    : (explicitImageOutput ?? inferKnownImageOutputSupport(entry.id, name, provider));
  const inputModalities =
    modalities.input ?? (supportsImageInput === true ? ["text", "image"] : undefined);
  const outputModalities =
    modalities.output ?? (supportsImageOutput === true ? ["text", "image"] : undefined);
  const pricing = entry.pricing && typeof entry.pricing === "object" ? entry.pricing : {};
  const promptPer1MUsd = parsePricePer1M((pricing as { readonly prompt?: unknown }).prompt);
  const completionPer1MUsd = parsePricePer1M(
    (pricing as { readonly completion?: unknown }).completion,
  );
  const blendedPer1MUsd =
    promptPer1MUsd !== undefined && completionPer1MUsd !== undefined
      ? promptPer1MUsd * 0.85 + completionPer1MUsd * 0.15
      : undefined;
  const estimatedSeriousTaskUsd =
    promptPer1MUsd !== undefined && completionPer1MUsd !== undefined
      ? (promptPer1MUsd / 1_000_000) * 120_000 + (completionPer1MUsd / 1_000_000) * 8_000
      : undefined;
  return {
    name,
    tier,
    modelId: entry.id,
    route,
    availableRoutes: [route],
    provider,
    contextLength:
      typeof entry.context_length === "number" && Number.isFinite(entry.context_length)
        ? entry.context_length
        : undefined,
    supportsStreaming: parseGatewayBoolean(entry.supports_streaming),
    supportsTools: parseGatewayBoolean(entry.supports_tools),
    supportsVision: supportsImageInput,
    supportsImageOutput,
    inputModalities,
    outputModalities,
    pricingKnown: typeof entry.pricing_known === "boolean" ? entry.pricing_known : undefined,
    pricing: {
      promptPer1MUsd,
      completionPer1MUsd,
      blendedPer1MUsd,
      estimatedSeriousTaskUsd,
    },
  };
}

function catalogKey(route: UnoModelRoute, modelId: string): string {
  return `${route === "russia" ? UNO_RUSSIA_PROVIDER_ID : UNO_PROVIDER_ID}/${modelId}`;
}

async function fetchUnoRouteModels(input: {
  readonly unoApiKey: string;
  readonly route: UnoModelRoute;
  readonly url: string;
}): Promise<UnoCatalog> {
  const response = await fetch(`${input.url}/models`, {
    headers: { Authorization: `Bearer ${input.unoApiKey}` },
  });
  if (!response.ok) return {};
  const payload = (await response.json()) as unknown;
  const rows: ReadonlyArray<UnoGatewayModelResponse> = Array.isArray(payload)
    ? (payload as ReadonlyArray<UnoGatewayModelResponse>)
    : payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
      ? (payload.data as ReadonlyArray<UnoGatewayModelResponse>)
      : [];
  const catalog: Record<string, UnoCatalogModel> = {};
  for (const entry of rows) {
    const normalized = normalizeUnoCatalogEntry(input.route, entry);
    if (!normalized) continue;
    catalog[catalogKey(input.route, normalized.modelId)] = normalized;
  }
  return catalog;
}

async function fetchUnoModelsCatalog(unoApiKey: string): Promise<UnoCatalog> {
  if (unoApiKey.length === 0) return {};
  const [defaultCatalog, russiaCatalog] = await Promise.all([
    fetchUnoRouteModels({ unoApiKey, route: "default", url: UNO_GATEWAY_BASE_URL }).catch(
      () => ({}),
    ),
    fetchUnoRouteModels({ unoApiKey, route: "russia", url: UNO_RUSSIA_GATEWAY_BASE_URL }).catch(
      () => ({}),
    ),
  ]);
  const availableRoutesByModel = new Map<string, UnoModelRoute[]>();
  for (const model of [...Object.values(defaultCatalog), ...Object.values(russiaCatalog)]) {
    const routes = availableRoutesByModel.get(model.modelId) ?? [];
    if (!routes.includes(model.route)) routes.push(model.route);
    availableRoutesByModel.set(model.modelId, routes);
  }
  const merged = { ...defaultCatalog, ...russiaCatalog };
  for (const [key, model] of Object.entries(merged)) {
    merged[key] = {
      ...model,
      availableRoutes: availableRoutesByModel.get(model.modelId) ?? [model.route],
    };
  }
  return merged;
}

interface UnoSearchBridge {
  readonly nodeBin: string;
  readonly scriptPath: string;
}

function resolveUnoSearchBridge(): UnoSearchBridge | undefined {
  const scriptPath = process.env.UNO_MCP_SEARCH_SCRIPT?.trim();
  const nodeBin = process.env.UNO_MCP_NODE_BIN?.trim() || process.execPath;
  if (!scriptPath || !existsSync(scriptPath)) return undefined;
  return { nodeBin, scriptPath };
}

function buildUnoConfigContent(
  unoApiKey: string,
  models: UnoCatalog,
  instructionsFilePath?: string,
): string {
  // opencode's config schema only accepts `{ name }`-shaped model entries;
  // strip the local tier metadata before injecting via OPENCODE_CONFIG_CONTENT.
  const opencodeModelsByProvider: Record<
    typeof UNO_PROVIDER_ID | typeof UNO_RUSSIA_PROVIDER_ID,
    Record<string, UnoOpenCodeModelConfig>
  > = {
    [UNO_PROVIDER_ID]: {},
    [UNO_RUSSIA_PROVIDER_ID]: {},
  };
  for (const model of Object.values(models)) {
    const providerId = model.route === "russia" ? UNO_RUSSIA_PROVIDER_ID : UNO_PROVIDER_ID;
    const options = defaultModelOptionsForUnoModel(model);
    opencodeModelsByProvider[providerId][model.modelId] = {
      name: model.name,
      ...(options ? { options } : {}),
    };
  }
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [UNO_IMAGE_GENERATION_AGENT_ID]: {
        description: "Generate images without exposing coding tools to image-generation models.",
        mode: "primary",
        hidden: true,
        permission: {
          "*": "deny",
        },
      },
    },
    provider: {
      [UNO_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Uno Global",
        options: {
          baseURL: UNO_GATEWAY_BASE_URL,
          apiKey: "{env:UNO_API_KEY}",
        },
        models: opencodeModelsByProvider[UNO_PROVIDER_ID],
      },
      [UNO_RUSSIA_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Uno Russia",
        options: {
          baseURL: UNO_RUSSIA_GATEWAY_BASE_URL,
          apiKey: "{env:UNO_API_KEY}",
        },
        models: opencodeModelsByProvider[UNO_RUSSIA_PROVIDER_ID],
      },
    },
    // Инструкции про встроенный браузер (путь к файлу). opencode дописывает
    // их к собственным инструкциям проекта.
    ...(instructionsFilePath ? { instructions: [instructionsFilePath] } : {}),
  };

  // Bundled Uno web-search MCP bridge — only enabled when the user is
  // signed in (apiKey present) and the desktop shell pointed us at the
  // bundled script via env. The bridge process inherits UNO_API_KEY and
  // UNO_GATEWAY_BASE_URL so `/v1/search` calls are authenticated against
  // the user's Uno LLM balance.
  const searchBridge = resolveUnoSearchBridge();
  if (unoApiKey.length > 0 && searchBridge) {
    config.mcp = {
      "uno-search": {
        type: "local",
        command: [searchBridge.nodeBin, searchBridge.scriptPath],
        environment: {
          UNO_API_KEY: unoApiKey,
          UNO_GATEWAY_BASE_URL,
          // Reuse Electron's binary as a Node interpreter for the bundled
          // `.mjs` script. Without this flag Electron spawns a windowed
          // GUI instance instead of the MCP server.
          ELECTRON_RUN_AS_NODE: "1",
        },
        enabled: true,
      },
    };
  }

  return JSON.stringify(config);
}

const UNO_DEFAULT_DISPLAY_NAME = "Uno";

function isUnoModelSlug(slug: string): boolean {
  return slug.startsWith(`${UNO_PROVIDER_ID}/`) || slug.startsWith(`${UNO_RUSSIA_PROVIDER_ID}/`);
}

export function metadataForCatalogModel(model: UnoCatalogModel): ModelCapabilitiesMetadata {
  const inputModalities =
    model.inputModalities ?? (model.supportsVision ? ["text", "image"] : ["text"]);
  const outputModalities =
    model.outputModalities ?? (model.supportsImageOutput ? ["text", "image"] : ["text"]);
  const supportsVision = modalitiesIncludeImage(inputModalities) ? true : model.supportsVision;

  return {
    tier: model.tier,
    routes: [...model.availableRoutes],
    defaultRoute: model.route,
    ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    supports: {
      ...(model.supportsStreaming !== undefined ? { streaming: model.supportsStreaming } : {}),
      ...(model.supportsTools !== undefined ? { tools: model.supportsTools } : {}),
      ...(supportsVision !== undefined
        ? { vision: supportsVision, attachments: supportsVision }
        : {}),
    },
    pricing: {
      ...(model.pricing.promptPer1MUsd !== undefined
        ? { promptPer1MUsd: model.pricing.promptPer1MUsd }
        : {}),
      ...(model.pricing.completionPer1MUsd !== undefined
        ? { completionPer1MUsd: model.pricing.completionPer1MUsd }
        : {}),
      ...(model.pricing.blendedPer1MUsd !== undefined
        ? { blendedPer1MUsd: model.pricing.blendedPer1MUsd }
        : {}),
      ...(model.pricing.estimatedSeriousTaskUsd !== undefined
        ? { estimatedSeriousTaskUsd: model.pricing.estimatedSeriousTaskUsd }
        : {}),
    },
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
  };
}

const filterUnoModels = (snapshot: ServerProviderDraft): ServerProviderDraft => ({
  ...snapshot,
  models: snapshot.models.filter((model) => isUnoModelSlug(model.slug)),
});

const stripUnoPrefix = (slug: string): string => {
  if (slug.startsWith(`${UNO_RUSSIA_PROVIDER_ID}/`)) {
    return slug.slice(UNO_RUSSIA_PROVIDER_ID.length + 1);
  }
  return slug.startsWith(`${UNO_PROVIDER_ID}/`) ? slug.slice(UNO_PROVIDER_ID.length + 1) : slug;
};

const withCatalogMetadata =
  (catalog: UnoCatalog) =>
  (snapshot: ServerProviderDraft): ServerProviderDraft => ({
    ...snapshot,
    models: snapshot.models.map(({ subProvider: _drop, ...model }) => {
      const catalogModel = catalog[model.slug];
      const metadata = catalogModel
        ? metadataForCatalogModel(catalogModel)
        : model.capabilities?.metadata;
      return {
        ...model,
        name: catalogModel?.name ?? model.name,
        ...(catalogModel?.provider ? { subProvider: catalogModel.provider } : {}),
        capabilities: {
          ...model.capabilities,
          ...(metadata ? { metadata } : {}),
        },
      };
    }),
  });

const sortUnoModels =
  (catalog: UnoCatalog) =>
  (snapshot: ServerProviderDraft): ServerProviderDraft => ({
    ...snapshot,
    models: snapshot.models.toSorted((a, b) => {
      const aId = stripUnoPrefix(a.slug);
      const bId = stripUnoPrefix(b.slug);

      const aPinned = PINNED_RANK.get(aId);
      const bPinned = PINNED_RANK.get(bId);
      if (aPinned !== undefined && bPinned !== undefined) return aPinned - bPinned;
      if (aPinned !== undefined) return -1;
      if (bPinned !== undefined) return 1;

      const aTier = catalog[a.slug]?.tier ?? "cheap";
      const bTier = catalog[b.slug]?.tier ?? "cheap";
      const tierDiff = TIER_RANK[aTier] - TIER_RANK[bTier];
      if (tierDiff !== 0) return tierDiff;

      const aRoute = catalog[a.slug]?.route ?? "default";
      const bRoute = catalog[b.slug]?.route ?? "default";
      if (aRoute !== bRoute) return aRoute === "default" ? -1 : 1;

      return aId.localeCompare(bId);
    }),
  });

export const __unoDriverTest = {
  buildUnoConfigContent,
  catalogKey,
  fetchUnoModelsCatalog,
  metadataForCatalogModel,
  normalizeUnoCatalogEntry,
  sortUnoModels,
} as const;

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
      const browserBridge = yield* BrowserBridge;
      const instructionsFilePath = writeBrowserInstructionsFile({
        stateDir: serverConfig.stateDir,
        baseUrl: browserBridge.baseUrl,
      });
      const baseProcessEnv = browserBridge.applyEnvironment(
        mergeProviderInstanceEnvironment(environment),
      );
      const processEnv: NodeJS.ProcessEnv = {
        ...baseProcessEnv,
        OPENCODE_CONFIG_CONTENT: buildUnoConfigContent(unoApiKey, unoCatalog, instructionsFilePath),
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
      const configuredBinary = config.binaryPath?.trim();
      // `makeBinaryPathSetting` (settings.ts:94) substitutes an empty/missing
      // `binaryPath` with the schema's fallback string — "opencode" for
      // `OpenCodeSettings` and "uno-code" for `UnoProviderSettings`. For the
      // Uno driver we never want either of those resolved via PATH: spawning
      // `opencode` picks up the user's homebrew install (v1.14.x, too old for
      // the Uno gateway), and `uno-code` is not a global command. Treat the
      // fallback markers as "not configured" so we use the bundled binary.
      const isSchemaFallback = configuredBinary === "opencode" || configuredBinary === "uno-code";
      const isStaleAbsolutePath =
        configuredBinary && nodePath.isAbsolute(configuredBinary) && !existsSync(configuredBinary);
      const effectiveBinary =
        !configuredBinary || isSchemaFallback || isStaleAbsolutePath
          ? UNO_BINARY_PATH
          : configuredBinary;
      const effectiveConfig = {
        ...config,
        binaryPath: effectiveBinary,
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
        UNO_PRESENTATION,
      ).pipe(
        Effect.map(filterUnoModels),
        Effect.map(withCatalogMetadata(unoCatalog)),
        Effect.map(sortByCatalog),
        Effect.map(stampIdentity),
        Effect.provideService(OpenCodeRuntime, openCodeRuntime),
      );

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          stampIdentity(
            sortByCatalog(
              withCatalogMetadata(unoCatalog)(
                filterUnoModels(makePendingOpenCodeProvider(settings, UNO_PRESENTATION)),
              ),
            ),
          ),
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
