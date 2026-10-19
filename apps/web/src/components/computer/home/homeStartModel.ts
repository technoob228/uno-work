/**
 * The model Home's composer starts a chat on, before the person picks one:
 * exactly what "New chat" would give now — the person's "New chats start on"
 * (Settings → AI) when it can run here, else the model last picked in any
 * chat composer (the draft store's sticky pick) when that harness is still
 * there, else the machine's usable default (the Uno gateway on a fresh Work
 * box). A harness not signed in on this computer is skipped: a new chat on it
 * opens straight into "Sign in to Codex" (Misha 18.10, uno-product).
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveSelectableModel } from "@t3tools/shared/model";

import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../../../modelSelection";
import { deriveProviderInstanceEntries } from "../../../providerInstances";
import { pickUsableDefaultModelSelection } from "../../../providerModels";

/** The harness can't answer here until someone signs it in. */
function signedOutHere(provider: ServerProvider): boolean {
  return provider.auth.status === "unauthenticated";
}

/**
 * "New chats start on" (Misha 15.10), when it can run on this computer now:
 * its harness on and installed, its model still listed. Null otherwise — new
 * chats then start the way they did before the setting, without a word.
 */
export function newChatModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const chosen = input.settings.newChatModelSelection ?? null;
  if (!chosen) return null;
  const provider = input.providers.find((candidate) => candidate.instanceId === chosen.instanceId);
  if (!provider?.enabled || !provider.installed || signedOutHere(provider)) return null;
  const entry = deriveProviderInstanceEntries(input.providers).find(
    (candidate) => candidate.instanceId === chosen.instanceId,
  );
  if (!entry) return null;
  // No stand-in model: a model gone from the list means the choice is off.
  const model = resolveSelectableModel(
    entry.driverKind,
    chosen.model,
    getAppModelOptionsForInstance(input.settings, entry),
  );
  return model ? { ...chosen, model } : null;
}

export function homeStartModelSelection(input: {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const chosen = newChatModelSelection(input);
  if (chosen) return chosen;
  const active = input.stickyActiveProvider;
  if (active) {
    const sticky = input.stickyModelSelectionByProvider[active];
    const provider = input.providers.find((candidate) => candidate.instanceId === active);
    if (sticky && provider?.enabled && provider.installed && !signedOutHere(provider)) {
      const model = resolveAppModelSelectionForInstance(
        active,
        input.settings,
        input.providers,
        sticky.model,
      );
      if (model) return { ...sticky, model };
    }
  }
  return pickUsableDefaultModelSelection(input.providers);
}

/** The chat would open on a sign-in or install card here, not an answer. */
function cannotRunHere(provider: ServerProvider | undefined): boolean {
  return !provider || !provider.enabled || !provider.installed || signedOutHere(provider);
}

/**
 * What "New chat" sets over the draft's own start: "New chats start on" when
 * it can run here; else, when what the draft would open on — the last pick, or
 * with none the project's default — can't run on this computer, the machine's
 * usable default; else null (the draft's start stands). A project added with
 * `uno-work project add` carries Codex as its default whether or not Codex is
 * signed in here (Misha 19.10, uno-product: "I never used Codex there").
 */
export function newThreadStartSelection(input: {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly projectDefault: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const chosen = newChatModelSelection(input);
  if (chosen) return chosen;
  const opensOn = input.stickyActiveProvider ?? input.projectDefault?.instanceId ?? null;
  if (opensOn === null || input.providers.length === 0) return null;
  const provider = input.providers.find((candidate) => candidate.instanceId === opensOn);
  return cannotRunHere(provider) ? pickUsableDefaultModelSelection(input.providers) : null;
}
