/**
 * T3 v2 compat: our `ServerConfig` → upstream `ServerConfig`
 * (packages/contracts/src/server.ts upstream). A curated minimum: upstream's
 * settings / keybindings / editors use the same field names as ours with
 * other shapes, and the phone does not need them, so they go out empty and
 * upstream's decoders fill their own defaults.
 */
import type { ServerConfig, ServerProvider } from "@t3tools/contracts";

import type { V2Json } from "./mapShell.ts";

export function toV2Provider(provider: ServerProvider): V2Json {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
    // The phone offers what we run: no runtime-mode toggle, no rollback.
    supportedRuntimeModes: ["full-access", "approval-required"],
    supportsConversationRollback: false,
    enabled: provider.enabled,
    installed: provider.installed,
    version: provider.version,
    status: provider.status,
    auth: { status: provider.auth.status },
    checkedAt: provider.checkedAt,
    ...(provider.message ? { message: provider.message } : {}),
    ...(provider.availability ? { availability: provider.availability } : {}),
    ...(provider.unavailableReason ? { unavailableReason: provider.unavailableReason } : {}),
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      ...(model.shortName ? { shortName: model.shortName } : {}),
      isCustom: model.isCustom,
      // Ours describe Uno tiers / reasoning options in our own shape.
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

export function toV2ServerConfig(config: ServerConfig): V2Json {
  return {
    environment: config.environment,
    auth: config.auth,
    cwd: config.cwd,
    keybindingsConfigPath: config.keybindingsConfigPath,
    keybindings: [],
    issues: [],
    providers: config.providers.map(toV2Provider),
    availableEditors: [],
    observability: {
      logsDirectoryPath: config.observability.logsDirectoryPath,
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
  };
}
