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

/**
 * What "New chat" sets over the draft's sticky pick: "New chats start on" when
 * it can run here; else, when the last pick's harness isn't signed in on this
 * computer, the machine's usable default; else null (the sticky pick stands).
 */
export function newThreadStartSelection(input: {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const chosen = newChatModelSelection(input);
  if (chosen) return chosen;
  const active = input.stickyActiveProvider;
  const provider = active
    ? input.providers.find((candidate) => candidate.instanceId === active)
    : undefined;
  return provider && signedOutHere(provider)
    ? pickUsableDefaultModelSelection(input.providers)
    : null;
}
