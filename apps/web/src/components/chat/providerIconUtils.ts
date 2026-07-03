import { type ModelCapabilities, ProviderDriverKind } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, HermesIcon, Icon, OpenAI, OpenCodeIcon, UnoIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("uno")]: UnoIcon,
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("hermes")]: HermesIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  capabilities?: ModelCapabilities | null | undefined;
};

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  if (options?.preferShortName && model.shortName) {
    return model.shortName;
  }
  return model.name;
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const modelName = getTriggerDisplayModelName(model);
  const subProvider = model.subProvider?.trim();
  if (!subProvider) return modelName;

  const normalizedName = modelName.toLocaleLowerCase();
  const normalizedProvider = subProvider.toLocaleLowerCase();
  if (
    normalizedName.startsWith(`${normalizedProvider}:`) ||
    normalizedName.startsWith(`${normalizedProvider} ·`)
  ) {
    return modelName;
  }
  return `${subProvider} · ${modelName}`;
}
