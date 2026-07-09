import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

// A harness we can actually route a turn to right now: enabled, its binary
// installed, and not an unavailable (unknown-driver) shadow.
const isInstalledProvider = (candidate: ServerProvider): boolean =>
  candidate.enabled && candidate.installed && isProviderAvailable(candidate);
// A harness the user has enabled (may be uninstalled). Used as a last resort
// so the UI can still surface a single "install this harness" hint.
const isEnabledProvider = (candidate: ServerProvider): boolean =>
  candidate.enabled && isProviderAvailable(candidate);

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver.
//
// Prefer a harness whose binary is actually installed. This is what lets an
// uninstalled-but-enabled default (e.g. the hardcoded `codex` seed on a
// machine without the Codex CLI) transparently fall back to whatever harness
// *is* installed — Claude, OpenCode, etc. — instead of staying stuck on the
// missing one and nagging the user with a "not installed" error.
//
// Only when nothing is installed do we keep the enabled-but-uninstalled
// selection, so the UI can still surface a single "install this harness" hint
// rather than erroring blindly. In other words: use any available harness,
// and surface the missing-harness state only when there is genuinely none.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  // 1. Honor the explicit request when the harness is actually usable.
  if (requestedEntry && isInstalledProvider(requestedEntry)) {
    return requestedEntry.driver;
  }
  // 2. Otherwise fall back to the first installed harness (any available one).
  const installedEntry = providers.find(isInstalledProvider);
  if (installedEntry) {
    return installedEntry.driver;
  }
  // 3. Nothing installed: preserve the enabled selection so the UI can show an
  //    install hint instead of guessing a driver from a missing instance id.
  if (requestedEntry && isEnabledProvider(requestedEntry)) {
    return requestedEntry.driver;
  }
  return providers.find(isEnabledProvider)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}
