/**
 * Pure helpers of the "Memory & models" blocks (AssistantMemoryModels.tsx):
 * model choices for the routing table, cost words and week totals for the
 * chats an assistant started.
 */
import type {
  AssistantChatSummary,
  AssistantChatsResult,
  ServerProvider,
} from "@t3tools/contracts";
import { ROUTING_SELF_HARNESS, type RoutingRule } from "@t3tools/shared/assistantMemory";

export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly harness: string;
  readonly model: string;
  readonly driver: string | null;
  /** Why it can't be used now; null = usable. */
  readonly reason: string | null;
}

export const SELF_VALUE = `${ROUTING_SELF_HARNESS}::`;

function providerReason(provider: ServerProvider): string | null {
  if (!provider.enabled) return "turned off";
  if (!provider.installed) return "not installed";
  if (provider.auth.status === "unauthenticated") return "not signed in";
  if (provider.status === "error" || provider.status === "disabled") return "not available";
  return null;
}

/** Every model of every harness on the assistant's computer, usable first. */
export function modelChoices(
  providers: ReadonlyArray<ServerProvider>,
  name: string,
): ReadonlyArray<ModelChoice> {
  const choices: ModelChoice[] = [
    {
      value: SELF_VALUE,
      label: `${name} answers itself`,
      harness: ROUTING_SELF_HARNESS,
      model: "",
      driver: null,
      reason: null,
    },
  ];
  for (const provider of providers) {
    if (provider.driver === "hermes") continue; // the assistant itself, not a chat harness
    const reason = providerReason(provider);
    const harnessName = provider.displayName ?? provider.instanceId;
    for (const model of provider.models) {
      choices.push({
        value: `${provider.instanceId}::${model.slug}`,
        label: `${harnessName} · ${model.shortName ?? model.name}`,
        harness: provider.instanceId,
        model: model.slug,
        driver: provider.driver,
        reason,
      });
    }
  }
  return choices;
}

export function choiceValue(rule: RoutingRule): string {
  return rule.harness === ROUTING_SELF_HARNESS ? SELF_VALUE : `${rule.harness}::${rule.model}`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function formatUsd(value: number): string {
  return value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/** What one chat cost, in words the person can check against Billing. */
export function chatCostText(
  chat: Pick<AssistantChatSummary, "billing" | "costUsd" | "aiHoursRequests">,
  gateway: AssistantChatsResult["gateway"],
): string {
  switch (chat.billing) {
    case "plan":
      return "In your plan";
    case "uno-ai-unlabelled":
      return "In the computer's total";
    case "other":
      return "Your own key";
    case "uno-ai":
      if (gateway !== "metered" || chat.costUsd === null) return "—";
      if (chat.costUsd > 0) return formatUsd(chat.costUsd);
      return (chat.aiHoursRequests ?? 0) > 0 ? "In AI hours" : "$0.00";
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export function weekTotals(chats: ReadonlyArray<AssistantChatSummary>, now: number) {
  const recent = chats.filter((chat) => now - Date.parse(chat.createdAt) <= WEEK_MS);
  return {
    usd: recent.reduce((sum, chat) => sum + (chat.costUsd ?? 0), 0),
    aiHoursChats: recent.filter((chat) => (chat.aiHoursRequests ?? 0) > 0).length,
    planChats: recent.filter((chat) => chat.billing === "plan").length,
    count: recent.length,
  };
}
