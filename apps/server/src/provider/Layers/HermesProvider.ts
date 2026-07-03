/**
 * HermesProvider — snapshot/status/model-catalog helpers for the Hermes
 * Agent driver (`hermes acp`, NousResearch hermes-agent).
 *
 * В отличие от Cursor модели НЕ discovery-этапом через ACP: Hermes на
 * провайдере `openai-api` отдаёт в `session/new` живой `/v1/models` Uno
 * Gateway целиком (1000+ строк апстрим-каталога). Вместо этого снапшот
 * строится из того же каталога Uno Gateway, что и UnoDriver — с tier'ами,
 * прайсингом и модальностями — отфильтрованного до agentic-подмножества.
 *
 * @module HermesProvider
 */
import type {
  HermesSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind, UNO_GATEWAY_BASE_URL } from "@t3tools/contracts";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  metadataForCatalogModel,
  normalizeUnoCatalogEntry,
  type UnoCatalogModel,
  type UnoGatewayModelResponse,
  type UnoModelTier,
} from "../Drivers/UnoDriver.ts";

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  // У Hermes нет plan-режима (ACP-режимы — только edit-approval политики),
  // поэтому переключатель build/plan в чате не показываем.
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_TIMEOUT_MS = 8_000;
const CATALOG_TIMEOUT_MS = 10_000;

const TIER_RANK: Record<UnoModelTier, number> = {
  frontier: 0,
  strong: 1,
  cheap: 2,
};

// Пикер Hermes — курируемое agentic-подмножество каталога гейтвея: гейтвей
// проксирует весь апстрим (1000+ моделей), из которых для харнесса релевантны
// вендоры с tool-use-моделями. Полный каталог остаётся доступен через
// customModels в настройках.
const HERMES_MODEL_VENDOR_ALLOWLIST = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "moonshotai",
  "x-ai",
  "z-ai",
  "minimax",
  "mistralai",
  "meta-llama",
  "nousresearch",
]);

// Дефолтная модель драйвера всегда должна присутствовать в пикере, даже если
// фетч каталога не удался.
export const HERMES_FALLBACK_MODEL_IDS = ["anthropic/claude-haiku-4.5"] as const;

export function isHermesPickerModel(model: UnoCatalogModel): boolean {
  if (!HERMES_MODEL_VENDOR_ALLOWLIST.has(model.provider.toLowerCase())) {
    return false;
  }
  // Image/audio-only модели харнессу не нужны.
  if (model.supportsTools === false) {
    return false;
  }
  if (
    model.outputModalities !== undefined &&
    !model.outputModalities.some((modality) => modality === "text")
  ) {
    return false;
  }
  return true;
}

export async function fetchHermesModelCatalog(
  unoApiKey: string,
): Promise<ReadonlyArray<UnoCatalogModel>> {
  if (unoApiKey.length === 0) return [];
  const response = await fetch(`${UNO_GATEWAY_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${unoApiKey}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as unknown;
  const rows: ReadonlyArray<UnoGatewayModelResponse> = Array.isArray(payload)
    ? (payload as ReadonlyArray<UnoGatewayModelResponse>)
    : payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
      ? (payload.data as ReadonlyArray<UnoGatewayModelResponse>)
      : [];
  const models: Array<UnoCatalogModel> = [];
  for (const entry of rows) {
    const normalized = normalizeUnoCatalogEntry("default", entry);
    if (normalized) models.push(normalized);
  }
  return models;
}

export function buildHermesModels(
  catalog: ReadonlyArray<UnoCatalogModel>,
): ReadonlyArray<ServerProviderModel> {
  const filtered = catalog.filter(isHermesPickerModel);
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = filtered
    .toSorted((a, b) => {
      const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.modelId.localeCompare(b.modelId);
    })
    .flatMap((model) => {
      if (seen.has(model.modelId)) return [];
      seen.add(model.modelId);
      return [
        {
          slug: model.modelId,
          name: model.name,
          isCustom: false,
          subProvider: model.provider,
          capabilities: createModelCapabilities({
            optionDescriptors: [],
            metadata: metadataForCatalogModel(model),
          }),
        } satisfies ServerProviderModel,
      ];
    });

  for (const fallbackId of HERMES_FALLBACK_MODEL_IDS) {
    if (!seen.has(fallbackId)) {
      models.push({
        slug: fallbackId,
        name: fallbackId,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }
  return models;
}

export function getHermesFallbackModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    buildHermesModels([]),
    PROVIDER,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): ServerProviderDraft {
  const checkedAt = new Date().toISOString();
  const models = getHermesFallbackModels(hermesSettings);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in Uno Work settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Hermes Agent availability...",
    },
  });
}

export interface HermesVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly message?: string;
}

/**
 * Parse `hermes acp --version` output.
 * Example: `Hermes ACP Adapter v0.18.0` / `Hermes Agent v0.18.0 (2026.7.1)`.
 */
export function parseHermesVersionOutput(result: CommandResult): HermesVersionResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/v(\d+\.\d+(?:\.\d+)?)/i);
  if (match?.[1]) {
    return { version: match[1], status: "ready" };
  }
  if (result.code === 0) {
    return { version: null, status: "ready" };
  }
  return {
    version: null,
    status: "error",
    message:
      "Could not determine Hermes Agent version. Install with `uv tool install \"hermes-agent[acp]\" --with \"mcp>=1.9\"`.",
  };
}

function hermesAuth(unoApiKey: string): {
  readonly auth: ServerProviderAuth;
  readonly message?: string;
} {
  if (unoApiKey.length > 0) {
    return {
      auth: {
        status: "authenticated",
        type: "uno-gateway",
        label: "Uno LLM Gateway",
      },
    };
  }
  return {
    auth: { status: "unauthenticated" },
    message: "Hermes uses the Uno LLM Gateway. Add your Uno API key in Settings → Providers → Uno.",
  };
}

const runHermesVersionCommand = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(hermesSettings.binaryPath, ["acp", "--version"], {
      env: environment,
      shell: process.platform === "win32",
    });
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  unoApiKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = new Date().toISOString();
  const fallbackModels = getHermesFallbackModels(hermesSettings);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in Uno Work settings.",
      },
    });
  }

  const versionProbe = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? 'Hermes Agent CLI (`hermes`) is not installed or not on PATH. Install with `uv tool install "hermes-agent[acp]" --with "mcp>=1.9"`.'
          : `Failed to execute Hermes CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI is installed but timed out while running `hermes acp --version`.",
      },
    });
  }

  const parsed = parseHermesVersionOutput(versionProbe.success.value);
  const { auth, message: authMessage } = hermesAuth(unoApiKey);

  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  let discoveryWarning: string | undefined;
  if (auth.status === "authenticated") {
    const catalogExit = yield* Effect.result(
      Effect.tryPromise(() => fetchHermesModelCatalog(unoApiKey)),
    );
    if (Result.isSuccess(catalogExit) && catalogExit.success.length > 0) {
      discoveredModels = buildHermesModels(catalogExit.success);
    } else {
      discoveryWarning = "Could not fetch the Uno Gateway model catalog for Hermes.";
    }
  }

  const messages = [parsed.message, authMessage, discoveryWarning]
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
    checkedAt,
    models: providerModelsFromSettings(
      discoveredModels.length > 0 ? discoveredModels : buildHermesModels([]),
      PROVIDER,
      hermesSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: parsed.version,
      status:
        auth.status === "unauthenticated"
          ? "error"
          : discoveryWarning && parsed.status === "ready"
            ? "warning"
            : parsed.status,
      auth,
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    },
  });
});

export type { ServerProvider };
