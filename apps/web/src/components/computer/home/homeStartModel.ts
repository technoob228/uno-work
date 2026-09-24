/**
 * The model Home's composer starts a chat on, before the person picks one:
 * exactly what "New chat" would give now — the model last picked in any chat
 * composer (the draft store's sticky pick) when that harness is still there,
 * else the machine's usable default (the Uno gateway on a fresh Work box).
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveAppModelSelectionForInstance } from "../../../modelSelection";
import { pickUsableDefaultModelSelection } from "../../../providerModels";

export function homeStartModelSelection(input: {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const active = input.stickyActiveProvider;
  if (active) {
    const sticky = input.stickyModelSelectionByProvider[active];
    const provider = input.providers.find((candidate) => candidate.instanceId === active);
    if (sticky && provider?.enabled && provider.installed) {
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
