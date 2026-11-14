/**
 * The agent of the developer way (13.11): Claude Code or Codex signed in with
 * the person's own plan, or Uno AI when they have neither. The pick becomes
 * the default for new chats the way setup's AI step does it (the draft
 * store's sticky model selection) and is kept in `settings.setup.answers` so
 * the first chat starts on it.
 */
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderAuthDriver,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { pickUsableDefaultModelSelection } from "../../providerModels";
import { signedInWithOwnAccount } from "../computer/home/agentStart";

export type DevAgentId = ProviderAuthDriver | "uno";

export const DEV_AGENTS: ReadonlyArray<ProviderAuthDriver> = ["claudeAgent", "codex"];

export const DEV_AGENT_LABEL: Readonly<Record<DevAgentId, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  uno: "Uno AI",
};

export function parseDevAgent(value: unknown): DevAgentId | null {
  return value === "claudeAgent" || value === "codex" || value === "uno" ? value : null;
}

const providerOf = (providers: ReadonlyArray<ServerProvider>, id: ProviderAuthDriver) =>
  providers.find((provider) => provider.instanceId === ProviderInstanceId.make(id));

/** Claude Code / Codex signed in with the person's own plan or key (not the plan's Uno AI credit). */
export function devAgentSignedIn(
  providers: ReadonlyArray<ServerProvider>,
  id: ProviderAuthDriver,
): boolean {
  return signedInWithOwnAccount(providerOf(providers, id));
}

/** The row picked at first: the saved pick, else the first agent signed in, else Claude Code. */
export function initialDevAgent(
  providers: ReadonlyArray<ServerProvider>,
  saved: DevAgentId | null,
): ProviderAuthDriver {
  if (saved === "claudeAgent" || saved === "codex") return saved;
  return DEV_AGENTS.find((id) => devAgentSignedIn(providers, id)) ?? "claudeAgent";
}

/** What new chats start on for this pick (null: that agent has no model to start on). */
export function devAgentSelection(
  id: DevAgentId,
  providers: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
): ModelSelection | null {
  if (id === "uno") {
    // "Uno AI" is the built-in AI, not one harness: Hermes, or Uno Code where Hermes can't answer.
    return pickUsableDefaultModelSelection(
      providers.filter((provider) => provider.driver === "hermes" || provider.driver === "uno"),
    );
  }
  const instanceId = ProviderInstanceId.make(id);
  const model = resolveAppModelSelectionForInstance(instanceId, settings, providers, null);
  return model ? { instanceId, model } : null;
}

/**
 * Where the developer way starts (Home's "Move my projects here", Misha 13.11):
 * at its sign-in, or — Claude Code or Codex already signed in with the
 * person's own plan — at the import, on that agent (the saved pick first).
 */
export function devWayStart(
  providers: ReadonlyArray<ServerProvider>,
  saved: DevAgentId | null,
): { readonly step: "sign-in" } | { readonly step: "import"; readonly agent: ProviderAuthDriver } {
  const usable = (id: DevAgentId | null): id is ProviderAuthDriver =>
    (id === "claudeAgent" || id === "codex") && devAgentSignedIn(providers, id);
  const agent = usable(saved) ? saved : DEV_AGENTS.find(usable);
  return agent ? { step: "import", agent } : { step: "sign-in" };
}
