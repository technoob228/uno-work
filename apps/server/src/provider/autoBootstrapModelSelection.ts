/**
 * autoBootstrapModelSelection — pick the default model for projects the server
 * creates on its own (the cwd bootstrap project and assistant workspaces).
 *
 * These projects get a default the user never chose, and it decides which
 * harness every new thread starts on — including the ones an assistant spawns
 * from Slack or Telegram without an explicit `modelSelection`. Hardcoding
 * `codex` was fine on a laptop where Codex is logged in; on a headless daemon
 * where it is not, every such thread failed and the operator had to remember
 * to pass a model with every single call.
 *
 * So the pick follows the machine: the first provider instance that is
 * actually installed, enabled, and authenticated wins, in a preference order
 * that puts the built-in Uno gateway first when it is connected.
 *
 * @module autoBootstrapModelSelection
 */
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  isProviderAvailable,
} from "@t3tools/contracts";

/**
 * The pick when nothing on the machine is usable (or provider probes have not
 * run yet) — the historical default, so behaviour is unchanged where it
 * already worked.
 */
export const FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
};

/**
 * Driver preference, most preferred first. The built-in Uno gateway leads:
 * when the box (or laptop) has a working Uno key, the out-of-the-box default
 * must answer without any harness login — Codex and Claude stay one click
 * away as "bring your own subscription" options. Providers that need a
 * subscription login rank next; the rest are ordered by how self-sufficient
 * they are for unattended work (OpenCode serves free Zen models without
 * auth, so it is the safety net when nothing else is signed in).
 *
 * Note: the Claude driver kind is `claudeAgent` (a bare `"claude"` entry
 * here would never match and silently unranked it).
 */
const DRIVER_PREFERENCE: ReadonlyArray<string> = [
  "uno",
  "codex",
  "claudeAgent",
  "opencode",
  "hermes",
  "cursor",
];

/** Usable for an unattended default: shipped, on, installed, and logged in. */
function isUsableForDefault(provider: ServerProvider): boolean {
  return (
    isProviderAvailable(provider) &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    resolveModel(provider) !== null
  );
}

/**
 * The driver's canonical default when the instance actually offers it,
 * otherwise its first advertised model. `null` means the instance reports no
 * models at all and cannot serve as a default. Also used by the agent-threads
 * bridge when an agent names a provider without a model.
 */
export function resolveModel(provider: ServerProvider): string | null {
  const preferred = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  if (preferred !== undefined && provider.models.some((model) => model.slug === preferred)) {
    return preferred;
  }
  const first = provider.models[0];
  if (first !== undefined) return first.slug;
  return preferred ?? null;
}

/**
 * Resolve the default model selection for a server-created project, or `null`
 * when no provider instance on this machine can serve as one.
 */
export function selectAutoBootstrapModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const usable = providers.filter(isUsableForDefault);
  if (usable.length === 0) return null;

  const ranked = usable.toSorted((left, right) => rank(left) - rank(right));
  const winner = ranked[0];
  if (winner === undefined) return null;

  const model = resolveModel(winner);
  if (model === null) return null;
  return { instanceId: winner.instanceId, model };
}

function rank(provider: ServerProvider): number {
  const index = DRIVER_PREFERENCE.indexOf(provider.driver);
  return index === -1 ? DRIVER_PREFERENCE.length : index;
}

/**
 * True when `selection` is a server-chosen default (never touched by the user)
 * that this machine cannot run — the only case where re-pointing an existing
 * project's default is safe.
 */
export function isUnusableAutoBootstrapDefault(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (selection === null) return false;
  if (
    selection.instanceId !== FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION.instanceId ||
    selection.model !== FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION.model
  ) {
    return false;
  }
  return !providers.some(
    (provider) => provider.instanceId === selection.instanceId && isUsableForDefault(provider),
  );
}
