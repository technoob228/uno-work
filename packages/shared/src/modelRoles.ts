/**
 * Settings → AI → "Default model" by role (14.11, Misha on T41 v3): which AI
 * does complex work, simple tasks and the assistant's own replies, and the
 * set Uno suggests for the plans connected here.
 *
 * - Only Uno AI: complex work on Smart, simple tasks and replies on Fast.
 * - A Claude or ChatGPT plan: complex work on the model its CLI recommends,
 *   simple tasks on its quick model, replies on Uno Fast.
 * - Both plans: complex work on Claude, simple tasks on Codex's quick model
 *   (it saves the Claude limit), replies on Uno Fast.
 *
 * Which model is strongest comes from the harness (modelStrength.ts, the
 * CLI's recommendation); which one is quick, from the gateway's catalog
 * (Uno AI: Fast) or the model's family (`haiku`, `luna`, `mini`…). Small
 * models are fine for simple tasks — never the default for complex work.
 *
 * Pure: no I/O.
 *
 * @module modelRoles
 */
import {
  type ModelSelection,
  type ServerProvider,
  UNO_FAST_GATEWAY_MODEL,
} from "@t3tools/contracts";

import type { RoutingRule } from "./assistantMemory.ts";
import { isWeakModel, strongestReadySelection } from "./modelStrength.ts";

export type PlanSource = "claude" | "codex" | "uno";

export interface PlanSources {
  /** Claude Code on the person's own sign-in (not on Uno credits). */
  readonly claude: ServerProvider | null;
  /** Codex signed in (ChatGPT plan or an API key). */
  readonly codex: ServerProvider | null;
  /** Uno AI (the `uno` harness: Smart / Fast in the plan's AI hours). */
  readonly uno: ServerProvider | null;
}

const signedIn = (provider: ServerProvider) => provider.auth.status === "authenticated";

/** The plans this computer can run chats on now. */
export function detectPlanSources(
  providers: ReadonlyArray<ServerProvider>,
  isReady: (provider: ServerProvider) => boolean,
): PlanSources {
  const find = (match: (provider: ServerProvider) => boolean) =>
    providers.find((provider) => isReady(provider) && match(provider)) ?? null;
  return {
    claude: find(
      (provider) =>
        provider.driver === "claudeAgent" && signedIn(provider) && provider.auth.type !== "unoAi",
    ),
    codex: find((provider) => provider.driver === "codex" && signedIn(provider)),
    uno: find((provider) => provider.driver === "uno"),
  };
}

const UNO_SMART_RE = /(^|\/)smart$/i;
const UNO_FAST_RE = /(^|\/)fast$/i;

/** Uno AI's included model for this role, by the gateway's catalog, else by its name. */
function unoIncluded(provider: ServerProvider, role: "smart" | "fast"): string | null {
  const included = provider.models.filter(
    (model) => model.capabilities?.metadata?.unoGroup === "included",
  );
  const byTier = included.find((model) =>
    role === "fast"
      ? model.capabilities?.metadata?.tier === "cheap"
      : model.capabilities?.metadata?.tier !== "cheap",
  );
  if (byTier !== undefined) return byTier.slug;
  const re = role === "fast" ? UNO_FAST_RE : UNO_SMART_RE;
  return provider.models.find((model) => re.test(model.slug))?.slug ?? null;
}

/** The harness's quick model for simple tasks: Uno Fast, else its small one (Haiku, Luna…). */
export function quickModel(provider: ServerProvider): string | null {
  if (provider.driver === "uno") return unoIncluded(provider, "fast");
  return provider.models.find((model) => isWeakModel(model.slug))?.slug ?? null;
}

export interface SuggestedRoles {
  /** Complex work and new chats ("Default model"). */
  readonly complex: ModelSelection | null;
  /** The "Simple tasks" row of the assistant's table. */
  readonly simple: ModelSelection | null;
  /** The assistant's own replies (Hermes on Uno AI); null: Uno AI isn't there. */
  readonly replies: { readonly provider: "uno"; readonly model: string } | null;
  readonly sources: ReadonlyArray<PlanSource>;
  /** One line: why the set is this one. */
  readonly why: string;
}

const pick = (provider: ServerProvider, model: string | null): ModelSelection | null =>
  model === null ? null : { instanceId: provider.instanceId, model };

const nameOf = (selection: ModelSelection | null, providers: ReadonlyArray<ServerProvider>) => {
  if (selection === null) return null;
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((entry) => entry.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
};

/**
 * The set Uno suggests for the plans here. `unoReplies`: the assistant can
 * answer on Uno AI on this computer (a gateway key is there).
 */
export function suggestRoles(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly isReady: (provider: ServerProvider) => boolean;
  readonly unoReplies: boolean;
}): SuggestedRoles {
  const { providers } = input;
  const found = detectPlanSources(providers, input.isReady);
  const sources: PlanSource[] = [];
  if (found.claude) sources.push("claude");
  if (found.codex) sources.push("codex");
  if (found.uno || input.unoReplies) sources.push("uno");
  const replies = input.unoReplies
    ? ({ provider: "uno", model: UNO_FAST_GATEWAY_MODEL } as const)
    : null;
  const plans = [found.claude, found.codex].filter(
    (provider): provider is ServerProvider => provider !== null,
  );
  const strongest = strongestReadySelection(plans, () => true)?.selection ?? null;
  const unoSmart = found.uno ? pick(found.uno, unoIncluded(found.uno, "smart")) : null;
  const unoFast = found.uno ? pick(found.uno, quickModel(found.uno)) : null;
  const complex = strongest ?? unoSmart;
  // Simple tasks: Codex's quick model when there is Codex (with Claude too it
  // saves the Claude limit), else Claude's, else Uno Fast; else complex's.
  const quickOf = (provider: ServerProvider | null) =>
    provider === null ? null : pick(provider, quickModel(provider));
  const simple = quickOf(found.codex) ?? quickOf(found.claude) ?? unoFast ?? complex;

  const complexName = nameOf(complex, providers);
  const simpleName = nameOf(simple, providers);
  const repliesPart = replies ? "; replies on Uno Fast" : "";
  let why: string;
  if (found.claude && found.codex) {
    why = `Claude and ChatGPT plans here: complex work on ${complexName} (Claude Code's pick), simple tasks on ${simpleName} through Codex to save the Claude limit${repliesPart}.`;
  } else if (found.claude || found.codex) {
    const plan = found.claude ? "Claude" : "ChatGPT";
    const cli = found.claude ? "Claude Code" : "Codex";
    why = `Your ${plan} plan here: complex work on ${complexName} (${cli}'s pick), simple tasks on its quick ${simpleName}${repliesPart}.`;
  } else if (found.uno) {
    why = `Only Uno AI here: complex work on Smart, simple tasks${replies ? " and replies" : ""} on Fast — both in your AI hours.`;
  } else {
    why = "No AI connected on this computer yet.";
  }
  return { complex, simple, replies, sources, why };
}

export function sameSelection(
  a: Pick<ModelSelection, "instanceId" | "model"> | null,
  b: Pick<ModelSelection, "instanceId" | "model"> | null,
): boolean {
  return a !== null && b !== null && a.instanceId === b.instanceId && a.model === b.model;
}

// ── "Simple tasks": a row of the assistant's ROUTING.md ─────────────────

/** The template's row (routingTemplate.ts); a new one gets this name. */
export const SIMPLE_TASK_TYPE = "Simple tasks, small fixes";
const SIMPLE_TASK_RE = /\bsimple\b/i;

export function simpleTaskRule(rules: ReadonlyArray<RoutingRule>): RoutingRule | null {
  return rules.find((rule) => SIMPLE_TASK_RE.test(rule.taskType)) ?? null;
}

/** The rows with "Simple tasks" set to this model, as the person's own row. */
export function withSimpleTask(
  rules: ReadonlyArray<RoutingRule>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ReadonlyArray<RoutingRule> {
  const current = simpleTaskRule(rules);
  const row: RoutingRule = {
    taskType: current?.taskType ?? SIMPLE_TASK_TYPE,
    harness: selection.instanceId,
    model: selection.model,
    effort: current?.effort ?? "",
    source: "you",
    note: "Settings → AI → Simple tasks",
  };
  return current === null ? [...rules, row] : rules.map((rule) => (rule === current ? row : rule));
}
