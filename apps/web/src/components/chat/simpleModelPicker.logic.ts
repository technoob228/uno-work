/**
 * The model picker without Dev mode (01.10): Smart, Fast, Premium — Uno AI —
 * and "your subscription" (Claude / ChatGPT) when one is signed in. The
 * column of harness icons (Uno, Codex, Claude, Cursor, Hermes, OpenCode, …)
 * and the full catalogue are for Dev mode.
 *
 * Uno AI comes from the gateway catalogue that Hermes (the default harness
 * for new chats) and Uno Code both list, grouped by `uno_group`. The chat's
 * own harness is kept when it is one of the two; otherwise Hermes, then Uno
 * Code.
 *
 * Pure: the caller says which harnesses are ready.
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ModelEsque } from "./providerIconUtils";

export interface SimplePickerEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly isDefault: boolean;
}

export interface SimpleModelChoice {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly label: string;
  readonly description: string;
}

export interface SimpleModelChoices {
  /** Smart, Fast — included in AI hours. */
  readonly included: ReadonlyArray<SimpleModelChoice>;
  /** Premium models (from premium credit), behind one "Premium" row. */
  readonly premium: ReadonlyArray<SimpleModelChoice>;
  /** The person's own Claude / ChatGPT subscription, when signed in here. */
  readonly subscriptions: ReadonlyArray<SimpleModelChoice>;
}

const GATEWAY_DRIVERS = ["hermes", "uno"] as const;

const SUBSCRIPTIONS: ReadonlyArray<{ readonly driver: string; readonly label: string }> = [
  { driver: "claudeAgent", label: "Claude" },
  { driver: "codex", label: "ChatGPT" },
];

function unoGroup(model: ModelEsque): string | null {
  const group = (model.capabilities as { metadata?: { unoGroup?: unknown } } | null | undefined)
    ?.metadata?.unoGroup;
  return typeof group === "string" ? group : null;
}

function displayName(model: ModelEsque): string {
  return model.shortName || model.name;
}

function pickEntry<E extends SimplePickerEntry>(
  entries: ReadonlyArray<E>,
  driver: string,
): E | undefined {
  const all = entries.filter((entry) => entry.driverKind === driver);
  return all.find((entry) => entry.isDefault) ?? all[0];
}

export function buildSimpleModelChoices<E extends SimplePickerEntry>(input: {
  readonly entries: ReadonlyArray<E>;
  readonly isReady: (entry: E) => boolean;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly activeModel: string | null;
}): SimpleModelChoices {
  const ready = input.entries.filter((entry) => input.isReady(entry));
  const active = ready.find((entry) => entry.instanceId === input.activeInstanceId);
  const gateway =
    active && (GATEWAY_DRIVERS as ReadonlyArray<string>).includes(active.driverKind)
      ? active
      : (pickEntry(ready, "hermes") ?? pickEntry(ready, "uno"));

  const included: SimpleModelChoice[] = [];
  const premium: SimpleModelChoice[] = [];
  if (gateway) {
    for (const model of input.modelOptionsByInstance.get(gateway.instanceId) ?? []) {
      const group = unoGroup(model);
      if (group !== "included" && group !== "premium") continue;
      const choice: SimpleModelChoice = {
        key: `${gateway.instanceId}:${model.slug}`,
        instanceId: gateway.instanceId,
        driverKind: gateway.driverKind,
        model: model.slug,
        label: displayName(model),
        description:
          group === "included"
            ? "Included in your AI hours"
            : "From premium credit, then your balance",
      };
      (group === "included" ? included : premium).push(choice);
    }
  }

  const subscriptions: SimpleModelChoice[] = [];
  for (const { driver, label } of SUBSCRIPTIONS) {
    const entry = pickEntry(ready, driver);
    if (!entry) continue;
    const models = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
    const model =
      entry.instanceId === input.activeInstanceId && input.activeModel
        ? input.activeModel
        : models[0]?.slug;
    if (!model) continue;
    subscriptions.push({
      key: `${entry.instanceId}:subscription`,
      instanceId: entry.instanceId,
      driverKind: entry.driverKind,
      model,
      label,
      description: "Your subscription",
    });
  }

  return { included, premium, subscriptions };
}

export function hasSimpleModelChoices(choices: SimpleModelChoices): boolean {
  return choices.included.length + choices.premium.length + choices.subscriptions.length > 0;
}

/** The row that is the chat's current pick (a subscription row matches by harness). */
export function isSimpleChoiceSelected(
  choice: SimpleModelChoice,
  active: { readonly instanceId: ProviderInstanceId | null; readonly model: string | null },
): boolean {
  if (choice.instanceId !== active.instanceId) return false;
  return choice.key.endsWith(":subscription") || choice.model === active.model;
}
