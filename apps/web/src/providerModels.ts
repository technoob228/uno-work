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
  // Prefer the driver's canonical default when the instance actually offers
  // it — mirrors the server's `resolveModel` (autoBootstrapModelSelection).
  // Falling back to the first advertised model is wrong for Uno, whose
  // snapshot pins headline models first regardless of whether the gateway
  // can currently serve them (e.g. Anthropic/OpenAI 403'd upstream).
  const preferred = DEFAULT_MODEL_BY_PROVIDER[provider];
  if (preferred !== undefined && models.some((model) => model.slug === preferred)) {
    return preferred;
  }
  return (
    models.find((model) => !model.isCustom)?.slug ?? models[0]?.slug ?? preferred ?? DEFAULT_MODEL
  );
}

/**
 * Preference order for machine-picked defaults (no explicit user choice):
 * built-in Uno AI first when its gateway key is live, then the
 * bring-your-own-subscription harnesses, then OpenCode (its free Zen models
 * answer without any login) as the safety net. Mirrors the server's
 * `autoBootstrapModelSelection` DRIVER_PREFERENCE.
 */
const DEFAULT_THREAD_DRIVER_PREFERENCE: ReadonlyArray<string> = [
  "uno",
  "codex",
  "claudeAgent",
  "opencode",
  "hermes",
  "cursor",
];

/**
 * A harness a machine-picked default may route a first message to: shipped,
 * enabled, installed, signed in (or keyless like the Uno gateway with a live
 * key), and actually advertising at least one model. This is deliberately
 * stricter than {@link resolveSelectableProvider}'s "installed" bar — an
 * installed-but-logged-out Codex must never swallow the first chat of a
 * fresh Work box.
 */
export function isUsableDefaultProvider(candidate: ServerProvider): boolean {
  return (
    candidate.enabled &&
    candidate.installed &&
    isProviderAvailable(candidate) &&
    candidate.status !== "disabled" &&
    candidate.status !== "error" &&
    candidate.auth.status === "authenticated" &&
    candidate.models.length > 0
  );
}

/**
 * Resolve the provider a brand-new thread starts on when the user has not
 * picked one themselves. `machineDefault` is the thread/project default
 * seeded by the server (or `null`); it is honored only when that harness is
 * actually usable. Otherwise the first usable harness wins in
 * {@link DEFAULT_THREAD_DRIVER_PREFERENCE} order, so a fresh Work box lands
 * on the built-in Uno gateway (or free OpenCode Zen) instead of a
 * logged-out Codex. With nothing usable at all this degrades to
 * {@link resolveSelectableProvider}'s legacy behavior so the UI can still
 * surface a single install/sign-in hint.
 */
export function resolveDefaultThreadProvider(
  providers: ReadonlyArray<ServerProvider>,
  machineDefault: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === machineDefault);
  if (requestedEntry && isUsableDefaultProvider(requestedEntry)) {
    return requestedEntry.driver;
  }
  const usable = providers
    .filter(isUsableDefaultProvider)
    .toSorted(
      (a, b) => defaultThreadPreferenceRank(a.driver) - defaultThreadPreferenceRank(b.driver),
    );
  const winner = usable[0];
  if (winner) {
    return winner.driver;
  }
  return resolveSelectableProvider(providers, machineDefault);
}

/**
 * The model a brand-new project should start on when the machine picks for
 * the user (browser onboarding's starter project). Same bar and order as
 * {@link resolveDefaultThreadProvider}: the first *usable* harness wins, and
 * its canonical default model is preferred over the first advertised one —
 * Uno pins headline models first that the gateway may not currently serve.
 * `null` when nothing is usable yet, so callers keep their own fallback.
 */
export function pickUsableDefaultModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): { readonly instanceId: ProviderInstanceId; readonly model: string } | null {
  const winner = providers
    .filter(isUsableDefaultProvider)
    .toSorted(
      (a, b) => defaultThreadPreferenceRank(a.driver) - defaultThreadPreferenceRank(b.driver),
    )[0];
  if (!winner) return null;
  const preferred = DEFAULT_MODEL_BY_PROVIDER[winner.driver];
  const model =
    (preferred !== undefined && winner.models.some((entry) => entry.slug === preferred)
      ? preferred
      : undefined) ??
    winner.models.find((entry) => !entry.isCustom)?.slug ??
    winner.models[0]?.slug;
  return model ? { instanceId: winner.instanceId, model } : null;
}

function defaultThreadPreferenceRank(driver: ProviderDriverKind): number {
  const index = DEFAULT_THREAD_DRIVER_PREFERENCE.indexOf(driver);
  return index === -1 ? DEFAULT_THREAD_DRIVER_PREFERENCE.length : index;
}
