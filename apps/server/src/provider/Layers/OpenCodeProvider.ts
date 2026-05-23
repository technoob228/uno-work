import {
  ProviderDriverKind,
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Cause, Data, Effect } from "effect";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { compareCliVersions } from "../cliVersion.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

const PROVIDER = ProviderDriverKind.make("opencode");

export interface ProviderPresentation {
  readonly displayName: string;
  readonly binaryCommand: string;
  readonly minimumVersion: string;
  readonly showInteractionModeToggle: boolean;
}

const OPENCODE_PRESENTATION: ProviderPresentation = {
  displayName: "OpenCode",
  binaryCommand: "opencode",
  minimumVersion: "1.14.19",
  showInteractionModeToggle: false,
} as const;

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
  readonly presentation: ProviderPresentation;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";
  const { displayName, binaryCommand } = input.presentation;

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: `${displayName} server rejected authentication. Check the server URL and password.`,
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured ${displayName} server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? `Failed to connect to the configured ${displayName} server.`,
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: `${displayName} CLI (\`${binaryCommand}\`) is not installed or not on PATH.`,
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message: `macOS is blocking the ${displayName} binary (quarantine). Run \`xattr -d com.apple.quarantine $(which ${binaryCommand})\` to fix this.`,
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message: `macOS killed the ${displayName} process due to an invalid code signature. The binary may be corrupted — try reinstalling ${displayName}.`,
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute ${displayName} CLI health check: ${detail}`
      : `Failed to execute ${displayName} CLI health check.`,
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
  presentation: ProviderPresentation = OPENCODE_PRESENTATION,
): ServerProviderDraft => {
  const checkedAt = new Date().toISOString();
  const { displayName } = presentation;
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          openCodeSettings.serverUrl.trim().length > 0
            ? `${displayName} is disabled in Uno Work settings. A server URL is configured.`
            : `${displayName} is disabled in Uno Work settings.`,
      },
    });
  }

  return buildServerProvider({
    presentation,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: `${displayName} provider status has not been checked in this session yet.`,
    },
  });
};

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  presentation: ProviderPresentation = OPENCODE_PRESENTATION,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const checkedAt = new Date().toISOString();
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;
  const { displayName, binaryCommand, minimumVersion } = presentation;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: openCodeSettings.serverUrl,
      presentation,
    });
    return buildServerProvider({
      presentation,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? `${displayName} is disabled in Uno Work settings. A server URL is configured.`
          : `${displayName} is disabled in Uno Work settings.`,
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCodeRuntime
        .runOpenCodeCommand({
          binaryPath: openCodeSettings.binaryPath,
          args: ["--version"],
          environment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version =
      parseGenericCliVersion(`${versionExit.value.stdout}\n${versionExit.value.stderr}`) ?? null;

    if (!version) {
      return fallback(
        new Error(
          `Unable to determine ${displayName} version from \`${binaryCommand} --version\` output. T3 Code requires ${displayName} v${minimumVersion} or newer.`,
        ),
        null,
      );
    }
    if (compareCliVersions(version, minimumVersion) < 0) {
      return buildServerProvider({
        presentation,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          customModels,
          DEFAULT_OPENCODE_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `${displayName} v${version} is too old. Upgrade to v${minimumVersion} or newer.`,
        },
      });
    }
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openCodeRuntime
          .connectToOpenCodeServer({
            binaryPath: openCodeSettings.binaryPath,
            serverUrl: openCodeSettings.serverUrl,
            environment,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
        return yield* openCodeRuntime
          .loadOpenCodeInventory(
            openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(isExternalServer && openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
      }),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = providerModelsFromSettings(
    flattenOpenCodeModels(inventoryExit.value),
    PROVIDER,
    customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const connectedCount = inventoryExit.value.providerList.connected.length;
  return buildServerProvider({
    presentation,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? `the configured ${displayName} server` : displayName}.`
          : isExternalServer
            ? `Connected to the configured ${displayName} server, but it did not report any connected upstream providers.`
            : `${displayName} is available, but it did not report any connected upstream providers.`,
    },
  });
});
