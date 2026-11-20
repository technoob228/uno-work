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
import { strongestReadySelection } from "@t3tools/shared/modelStrength";

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
  // Codex with no account answers "ready" (server: personRouting.ts, 12.11).
  if (provider.driver === "codex" && provider.auth.status !== "authenticated") {
    return "not signed in";
  }
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
      return (chat.aiHoursRequests ?? 0) > 0 ? "In AI time" : "$0.00";
  }
}

/**
 * Under the token count, when it isn't Uno's money: a chat on the person's
 * Claude / ChatGPT subscription is "in your … plan" (decision 02.10: no $).
 */
export function chatTokensNote(
  chat: Pick<AssistantChatSummary, "billing" | "instanceId" | "harness">,
): string | null {
  if (chat.billing !== "plan") return null;
  const harness = `${chat.instanceId} ${chat.harness}`.toLowerCase();
  if (harness.includes("codex") || harness.includes("chatgpt")) return "in your ChatGPT plan";
  if (harness.includes("cursor")) return "in your Cursor plan";
  return "in your Claude plan";
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

// ── Auto for the assistant's work (13.11) ───────────────────────────

/**
 * What Auto runs on now — the server's pick (personRouting.ts
 * `strongestReadyModelSelection`): Claude Opus → Codex's strong models → Uno
 * AI premium. null: none of them is ready on this computer.
 */
export function autoWorkChoice(
  providers: ReadonlyArray<ServerProvider>,
  choices: ReadonlyArray<ModelChoice>,
  harnessUnoCredits: Readonly<Record<string, boolean>> = {},
): ModelChoice | null {
  const strongest = strongestReadySelection(
    providers,
    (provider) =>
      providerReason(provider) === null &&
      (provider.auth.type !== "unoAi" || harnessUnoCredits[provider.driver] === true),
  );
  if (strongest === null) return null;
  const value = `${strongest.selection.instanceId}::${strongest.selection.model}`;
  return choices.find((choice) => choice.value === value) ?? null;
}

/** A harness the row names that isn't on this computer, as people call it. */
const HARNESS_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  uno: "Uno AI",
};

export interface AppliedRule {
  readonly taskType: string;
  /** "Claude · Opus 5.5 · high" — what the row starts chats on. */
  readonly model: string;
  /** Why it can't start here now (the assistant asks first); null: it applies. */
  readonly notReady: string | null;
}

/**
 * The person's own rows of ROUTING.md (Source `you`) — set in the table, by
 * "Edit file" or in a chat — as Settings shows them: "Your rules from
 * ROUTING.md · applied" (Misha 14.11: the person must see the file's rules
 * are theirs and are used).
 */
export function appliedPersonRules(
  rules: ReadonlyArray<RoutingRule>,
  choices: ReadonlyArray<ModelChoice>,
): ReadonlyArray<AppliedRule> {
  return rules
    .filter((rule) => rule.source === "you")
    .map((rule) => {
      const choice = choices.find((entry) => entry.value === choiceValue(rule));
      const harness = HARNESS_NAMES[rule.harness] ?? rule.harness;
      const model = choice?.label ?? [harness, rule.model].filter(Boolean).join(" · ");
      const effort = rule.effort.trim();
      return {
        taskType: rule.taskType,
        model: effort ? `${model} · ${effort}` : model,
        notReady:
          rule.harness === ROUTING_SELF_HARNESS
            ? null
            : choice === undefined
              ? "not on this computer"
              : choice.reason,
      };
    });
}
