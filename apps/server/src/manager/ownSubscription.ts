/**
 * The owner's own Claude / ChatGPT subscription on this computer, as a signal
 * for the Uno assistant (decision 10.10): Uno coordinates on Uno AI, and the
 * heavy work it starts goes to a Claude Code / Codex chat on the owner's
 * subscription — when, and only when, the owner is signed in here.
 *
 * "Signed in" is what the daemon's provider probes found
 * (`ProviderRegistry.getProviders` → `ServerProvider.auth`), read through
 * `chatRunsOn` (shared with the chat header): Claude Code on Uno AI
 * (`auth.type` "unoAi") and a harness signed in with an API key are NOT a
 * subscription.
 *
 * Three users, one answer:
 *  - `ai_status` of uno-manager — what Uno is told before it starts work;
 *  - `pickSpawnSelection` — what a chat Uno starts runs on when Uno named no
 *    model, or named a harness this computer can't run;
 *  - the instructions (AGENTS.md) only say "ask `ai_status`", never guess.
 *
 * Pure: no I/O.
 *
 * @module manager/ownSubscription
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { harnessForAccountDefaultAi } from "@t3tools/shared/assistantLlm";
import {
  CHAT_RUNS_ON_LABEL,
  chatRunsOn,
  isOwnSubscription,
  type ChatRunsOn,
} from "@t3tools/shared/chatRunsOn";

import {
  isUsableForDefault,
  resolveModel,
  selectAutoBootstrapModelSelection,
} from "../provider/autoBootstrapModelSelection.ts";

/** Subscriptions Uno may put heavy work on, in the order they are tried. */
const SUBSCRIPTION_DRIVERS: ReadonlyArray<{
  readonly driver: string;
  readonly name: "Claude" | "ChatGPT";
}> = [
  { driver: "claudeAgent", name: "Claude" },
  { driver: "codex", name: "ChatGPT" },
];

/** Models listed to the assistant per subscription (ids it can pass on). */
const MAX_LISTED_MODELS = 12;

export interface OwnSubscription {
  /** Harness instance id — `modelSelection.instanceId` of a chat on it. */
  readonly harness: string;
  readonly name: "Claude" | "ChatGPT";
  /** "Claude Max Subscription", "ChatGPT Plus Subscription"; null: the probe named none. */
  readonly plan: string | null;
  readonly runsOn: Extract<ChatRunsOn, "claude-plan" | "chatgpt-plan">;
  /** The harness's default model here. */
  readonly modelSelection: ModelSelection;
  readonly models: ReadonlyArray<string>;
}

/**
 * The subscriptions the owner is signed in to on this computer and a chat can
 * run on right now — Claude first, then ChatGPT; `preferred` (a harness
 * instance id, e.g. the account's default AI) moves to the front.
 */
export function ownSubscriptions(
  providers: ReadonlyArray<ServerProvider>,
  preferred: string | null = null,
): ReadonlyArray<OwnSubscription> {
  const found: OwnSubscription[] = [];
  for (const { driver, name } of SUBSCRIPTION_DRIVERS) {
    for (const provider of providers) {
      if (provider.driver !== driver || !isUsableForDefault(provider)) continue;
      const runsOn = chatRunsOn({ provider });
      if (runsOn !== "claude-plan" && runsOn !== "chatgpt-plan") continue;
      const model = resolveModel(provider);
      if (model === null) continue;
      found.push({
        harness: provider.instanceId,
        name,
        plan: provider.auth.label ?? null,
        runsOn,
        modelSelection: { instanceId: provider.instanceId, model },
        models: provider.models.slice(0, MAX_LISTED_MODELS).map((entry) => entry.slug),
      });
    }
  }
  if (preferred === null) return found;
  return [
    ...found.filter((entry) => entry.harness === preferred),
    ...found.filter((entry) => entry.harness !== preferred),
  ];
}

/**
 * True when the daemon KNOWS a Claude Code / Codex chat on this selection
 * can't run now: the harness is off, not installed, or not signed in. Only
 * these two — the harnesses a person signs in to — are judged: an instance
 * the registry doesn't list, one whose sign-in couldn't be verified, and
 * every other harness (Hermes runs the assistant even when it is hidden
 * from the pickers) are left alone — no signal, no interference.
 */
export function isKnownUnrunnable(
  selection: Pick<ModelSelection, "instanceId">,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined) return false;
  if (!SUBSCRIPTION_DRIVERS.some((entry) => entry.driver === provider.driver)) return false;
  return (
    !isProviderAvailable(provider) ||
    !provider.enabled ||
    !provider.installed ||
    provider.status === "disabled" ||
    provider.auth.status === "unauthenticated"
  );
}

/**
 * What a chat the Uno assistant starts runs on.
 *
 *  - Uno named a selection this computer can run → that one.
 *  - Uno named none, or Claude Code / Codex that the daemon knows can't run
 *    (not signed in): the owner's signed-in subscription (the account's default AI
 *    first, then Claude, then ChatGPT); with no subscription, the account's
 *    default AI when it is usable here (as before 10.10).
 *  - Uno named a harness that can't run and none of the above is there:
 *    whatever this computer can run (Uno AI first — the same pick as a new
 *    project's default).
 *  - Nothing of that → null: the caller keeps what Uno named, else the
 *    project's default.
 */
export function pickSpawnSelection(input: {
  readonly requested: ModelSelection | null;
  /** The account's `default_ai` ("uno", "claude", "codex", …), when known. */
  readonly defaultAi: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ModelSelection | null {
  const { requested, providers } = input;
  if (requested !== null && !isKnownUnrunnable(requested, providers)) return requested;
  const defaultHarness = harnessForAccountDefaultAi(input.defaultAi);
  const subscription = ownSubscriptions(providers, defaultHarness)[0];
  if (subscription !== undefined) return subscription.modelSelection;
  const provider =
    defaultHarness === null
      ? undefined
      : providers.find((entry) => entry.instanceId === defaultHarness);
  if (provider !== undefined && isUsableForDefault(provider)) {
    const model = resolveModel(provider);
    if (model !== null) return { instanceId: provider.instanceId, model };
  }
  // Uno named a harness that can't run and the account says nothing usable:
  // what this computer can run (Uno AI first) beats a chat that only errors.
  return requested === null ? null : selectAutoBootstrapModelSelection(providers);
}

/** A subscription harness the owner could sign in to, and isn't. */
export interface SubscriptionNotSignedIn {
  readonly harness: string;
  readonly name: "Claude" | "ChatGPT";
  readonly why: "not signed in" | "not installed" | "turned off" | "runs on Uno AI" | "API key";
}

/** `ai_status` of uno-manager: what this computer can run a chat on now. */
export interface AiStatus {
  /** The owner's subscriptions signed in on this computer, best first. */
  readonly ownSubscriptions: ReadonlyArray<{
    readonly harness: string;
    readonly name: "Claude" | "ChatGPT";
    readonly plan: string | null;
    readonly defaultModel: string;
    readonly models: ReadonlyArray<string>;
  }>;
  /** Claude / ChatGPT harnesses that are NOT on the owner's subscription, and why. */
  readonly notSignedIn: ReadonlyArray<SubscriptionNotSignedIn>;
  /** Where heavy work goes now. */
  readonly heavyWork: {
    /** Pass it to `create_thread`; null: follow ROUTING.md as before. */
    readonly modelSelection: ModelSelection | null;
    /** The words the person sees in that chat's header. */
    readonly runsOn: string;
    readonly whoPays: string;
  };
  /** What to do with it, in one paragraph. */
  readonly rule: string;
}

function notSignedInReason(provider: ServerProvider): SubscriptionNotSignedIn["why"] | null {
  if (!isProviderAvailable(provider) || !provider.installed) return "not installed";
  if (!provider.enabled || provider.status === "disabled") return "turned off";
  const runsOn = chatRunsOn({ provider });
  if (isOwnSubscription(runsOn)) return null;
  if (runsOn === "uno-ai") return "runs on Uno AI";
  if (runsOn === "own-key") return "API key";
  return "not signed in";
}

export const AI_STATUS_RULE_SUBSCRIPTION =
  "The owner is signed in to their own subscription on this computer. Start heavy work (coding, long multi-step builds, big refactors, anything that takes many steps) in a chat on it: pass heavyWork.modelSelection to create_thread (add options from ROUTING.md for effort; a ROUTING.md row with Source `you` still decides the model). You stay the coordinator: brief the chat, wait_for_thread, check the evidence, report in your own chat. Tell the person in one line where the work runs (heavyWork.runsOn).";

export const AI_STATUS_RULE_UNO_AI =
  "The owner is not signed in to a Claude or ChatGPT subscription on this computer. Work as before, on Uno AI: follow ROUTING.md. Don't ask them to sign in unless they bring it up; if they do, it is Settings → AI → Your subscription.";

export function aiStatus(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly defaultAi: string | null;
}): AiStatus {
  const { providers } = input;
  const subscriptions = ownSubscriptions(providers, harnessForAccountDefaultAi(input.defaultAi));
  const notSignedIn: SubscriptionNotSignedIn[] = [];
  for (const { driver, name } of SUBSCRIPTION_DRIVERS) {
    for (const provider of providers) {
      if (provider.driver !== driver) continue;
      if (subscriptions.some((entry) => entry.harness === provider.instanceId)) continue;
      const why = notSignedInReason(provider) ?? "not signed in";
      notSignedIn.push({ harness: provider.instanceId, name, why });
    }
  }
  const first = subscriptions[0];
  return {
    ownSubscriptions: subscriptions.map((entry) => ({
      harness: entry.harness,
      name: entry.name,
      plan: entry.plan,
      defaultModel: entry.modelSelection.model,
      models: entry.models,
    })),
    notSignedIn,
    heavyWork:
      first === undefined
        ? {
            modelSelection: null,
            runsOn: CHAT_RUNS_ON_LABEL["uno-ai"],
            whoPays: "Uno AI: the owner's AI time and premium credit.",
          }
        : {
            modelSelection: first.modelSelection,
            runsOn: CHAT_RUNS_ON_LABEL[first.runsOn],
            whoPays: `The owner's ${first.name} subscription. Uno doesn't charge for its AI; the subscription's limits apply.`,
          },
    rule: first === undefined ? AI_STATUS_RULE_UNO_AI : AI_STATUS_RULE_SUBSCRIPTION,
  };
}
