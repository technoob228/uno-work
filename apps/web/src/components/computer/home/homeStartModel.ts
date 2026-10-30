/**
 * The model Home's composer starts a chat on, before the person picks one:
 * exactly what "New chat" would give now — the person's "New chats start on"
 * (Settings → AI) when it can run here, else the model last picked in any
 * chat composer (the draft store's sticky pick) when that harness is still
 * there, else Claude Code when the person's Claude plan is signed in here,
 * else the machine's usable default (the Uno gateway on a fresh Work box). A
 * harness not signed in on this computer is skipped: a new chat on it opens
 * straight into "Sign in to Codex" (Misha 18.10, uno-product).
 */
import type {
  ModelSelection,
  ProviderAuthDriver,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { UNO_SMART_GATEWAY_MODEL } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveSelectableModel } from "@t3tools/shared/model";

import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../../../modelSelection";
import { deriveProviderInstanceEntries } from "../../../providerInstances";
import { isUsableDefaultProvider, pickUsableDefaultModelSelection } from "../../../providerModels";
import { signedInWithOwnAccount } from "./agentStart";

/** The harness can't answer here until someone signs it in. */
function signedOutHere(provider: ServerProvider): boolean {
  return provider.auth.status === "unauthenticated";
}

/**
 * "New chats start on" (Misha 15.10), when it can run on this computer now:
 * its harness on and installed, its model still listed. Null otherwise — new
 * chats then start the way they did before the setting, without a word.
 */
function usableNewChatChoice(
  chosen: ModelSelection,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly settings: UnifiedSettings;
  },
): ModelSelection | null {
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

/**
 * The most specific choice that can run here: the project's, then the
 * computer's, then the app's "New chats start on". One that can't run steps
 * aside for the next, not for nothing.
 */
export function newChatModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly projectChoice?: ModelSelection | null;
}): ModelSelection | null {
  for (const chosen of [
    input.projectChoice,
    input.settings.defaultModelSelection,
    input.settings.newChatModelSelection,
  ]) {
    if (!chosen) continue;
    const usable = usableNewChatChoice(chosen, input);
    if (usable) return usable;
  }
  return null;
}

/** OpenCode's Smart: the gateway's `uno/smart` under OpenCode's `uno` provider. */
const OPENCODE_SMART_MODEL = `uno/${UNO_SMART_GATEWAY_MODEL}`;

/**
 * Where Home starts for a person who came for their own agent (goal
 * `own_agent`; agent-flow pass 25.10: Home went to "uno · Smart"): the agent
 * they picked before Work when it is signed in here with their own account,
 * else any of Claude Code / Codex signed in that way, else OpenCode on Uno AI
 * (Smart) — the agent that works with no sign-in at all. Null when none of
 * these can run here (Home starts as for everyone).
 */
export function ownAgentStartSelection(input: {
  readonly picked: ProviderAuthDriver | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  /** OpenCode picked before Work (account default AI): it goes first. */
  readonly openCodeFirst?: boolean;
}): ModelSelection | null {
  const byDriver = (driver: string) =>
    input.providers.find((candidate) => candidate.instanceId === driver);
  const openCodeSmart = (): ModelSelection | null => {
    const opencode = byDriver("opencode");
    if (!opencode || !isUsableDefaultProvider(opencode)) return null;
    const model = resolveAppModelSelectionForInstance(
      opencode.instanceId,
      input.settings,
      input.providers,
      opencode.models.some((entry) => entry.slug === OPENCODE_SMART_MODEL)
        ? OPENCODE_SMART_MODEL
        : null,
    );
    return model ? { instanceId: opencode.instanceId, model } : null;
  };
  if (input.openCodeFirst) {
    const first = openCodeSmart();
    if (first) return first;
  }
  const order: ReadonlyArray<ProviderAuthDriver> = [
    ...(input.picked ? [input.picked] : []),
    "claudeAgent",
    "codex",
  ];
  for (const driver of order) {
    const provider = byDriver(driver);
    if (!provider || !signedInWithOwnAccount(provider)) continue;
    const model = resolveAppModelSelectionForInstance(
      provider.instanceId,
      input.settings,
      input.providers,
      null,
    );
    if (model) return { instanceId: provider.instanceId, model };
  }
  return openCodeSmart();
}

/**
 * Claude Code signed in to the person's Claude plan here (not Uno AI, not an
 * API key): with no pick of theirs, new chats start there (Misha 28.10, P2:
 * "Claude just signed in, the new chat said uno · Smart"). The rule: a Claude
 * subscription on this computer → Claude; none → Uno · Smart as before.
 */
export function claudePlanStartSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const claude = input.providers.find((candidate) => candidate.instanceId === "claudeAgent");
  if (!claude || !claude.enabled || !signedInWithOwnAccount(claude)) return null;
  const type = claude.auth.type;
  if (type === undefined || type === "apiKey") return null;
  const model = resolveAppModelSelectionForInstance(
    claude.instanceId,
    input.settings,
    input.providers,
    null,
  );
  return model ? { instanceId: claude.instanceId, model } : null;
}

/** The person came for their own agent (useOwnAgentStart): where their chats start. */
export interface OwnAgentStart {
  readonly picked: ProviderAuthDriver | null;
  readonly openCodeFirst?: boolean;
}

export function homeStartModelSelection(input: {
  readonly stickyActiveProvider: ProviderInstanceId | null;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  /** The person came for their own agent: start there unless they picked otherwise. */
  readonly ownAgent?: OwnAgentStart | null;
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
  const ownAgent = input.ownAgent
    ? ownAgentStartSelection({
        picked: input.ownAgent.picked,
        providers: input.providers,
        settings: input.settings,
        ...(input.ownAgent.openCodeFirst ? { openCodeFirst: true } : {}),
      })
    : null;
  return (
    ownAgent ?? claudePlanStartSelection(input) ?? pickUsableDefaultModelSelection(input.providers)
  );
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
  /** Set for this project in Settings: beats everything else. */
  readonly projectChoice?: ModelSelection | null;
  /**
   * The person came for their own agent: with no pick of theirs yet, a new
   * chat starts there, not on the project's default (the machine's own
   * harness, seeded before they picked anything) — 28.10, 0.0.155: OpenCode
   * picked in the configurator, New chat opened on "uno · Smart".
   */
  readonly ownAgent?: OwnAgentStart | null;
}): ModelSelection | null {
  const chosen = newChatModelSelection(input);
  if (chosen) return chosen;
  if (input.ownAgent && input.stickyActiveProvider === null) {
    const ownAgent = ownAgentStartSelection({
      picked: input.ownAgent.picked,
      providers: input.providers,
      settings: input.settings,
      ...(input.ownAgent.openCodeFirst ? { openCodeFirst: true } : {}),
    });
    if (ownAgent) return ownAgent;
  }
  // No pick of theirs yet and their Claude plan signed in here: Claude, not
  // the project's default (seeded by the machine, often before the sign-in).
  if (input.stickyActiveProvider === null) {
    const claudePlan = claudePlanStartSelection(input);
    if (claudePlan) return claudePlan;
  }
  const opensOn = input.stickyActiveProvider ?? input.projectDefault?.instanceId ?? null;
  if (opensOn === null || input.providers.length === 0) return null;
  const provider = input.providers.find((candidate) => candidate.instanceId === opensOn);
  return cannotRunHere(provider) ? pickUsableDefaultModelSelection(input.providers) : null;
}
