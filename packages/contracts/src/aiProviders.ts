/**
 * AI providers of a machine and the model of the Uno assistant (0.0.84).
 *
 * The Uno assistant chat (thread.assistantRole = "chat") always runs on the
 * Hermes harness. Its LLM comes from one of two places:
 *
 * - `uno` — the Uno AI gateway with the machine's gateway key (default); spend
 *   counts against the key's limits and the account's credits, labelled as
 *   the assistant (`/v1/apps/uno-assistant`);
 * - bring your own key — an API key of another provider the person stored on
 *   this machine (xAI, OpenRouter, OpenAI, or any OpenAI-compatible base URL
 *   as "custom"). Billed by that provider; Uno spend limits don't apply;
 * - the person's own subscription (Misha 14.10) — `claude`: their Claude
 *   Pro / Max plan through Nous' official Hermes plugin, which drives the
 *   official Claude Code CLI signed in on this computer; `chatgpt`: their
 *   ChatGPT plan through Hermes' own `openai-codex` sign-in (its own tokens,
 *   apart from the Codex CLI's). Uno doesn't charge for these.
 *
 * Keys live in the daemon's secret store and never leave it: every read of a
 * key returns only its last four characters.
 *
 * Which provider and model the assistant uses is a property of the chat's
 * model selection: `{ instanceId: "hermes", model, options: [{ id:
 * "llmProvider", value }] }` — so the header, the turn and the harness all
 * read the same thing.
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/** Providers a person can bring a key for. */
export const ByokProviderId = Schema.Literals(["xai", "openrouter", "openai", "custom"]);
export type ByokProviderId = typeof ByokProviderId.Type;

export const BYOK_PROVIDER_IDS: ReadonlyArray<ByokProviderId> = [
  "xai",
  "openrouter",
  "openai",
  "custom",
];

/** Where the assistant's LLM comes from: the Uno gateway, a stored key, or a subscription. */
export const AssistantLlmProvider = Schema.Literals([
  "uno",
  "xai",
  "openrouter",
  "openai",
  "custom",
  "claude",
  "chatgpt",
]);
export type AssistantLlmProvider = typeof AssistantLlmProvider.Type;

/** The person's own subscriptions the assistant can run on. */
export const SubscriptionLlmProvider = Schema.Literals(["claude", "chatgpt"]);
export type SubscriptionLlmProvider = typeof SubscriptionLlmProvider.Type;

export const SUBSCRIPTION_LLM_PROVIDERS: ReadonlyArray<SubscriptionLlmProvider> = [
  "claude",
  "chatgpt",
];

export function isSubscriptionLlmProvider(
  provider: AssistantLlmProvider,
): provider is SubscriptionLlmProvider {
  return provider === "claude" || provider === "chatgpt";
}

/** Hermes' provider id for each subscription (`HERMES_INFERENCE_PROVIDER`, config.yaml). */
export const HERMES_SUBSCRIPTION_PROVIDER_IDS: Readonly<Record<SubscriptionLlmProvider, string>> = {
  claude: "claude-subscription-directsdk-experimental",
  chatgpt: "openai-codex",
};

/**
 * Oldest Hermes that loads the Claude plugin (its `requires_hermes`). Hermes
 * since 0.20 ships only through its own installer — PyPI stops at 0.19.
 */
export const HERMES_CLAUDE_PLUGIN_MIN_VERSION = "0.21.4";

/** OpenAI-compatible base URLs of the built-in BYOK providers. */
export const BYOK_PROVIDER_BASE_URLS: Readonly<Record<Exclude<ByokProviderId, "custom">, string>> =
  {
    xai: "https://api.x.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    openai: "https://api.openai.com/v1",
  };

export const AI_PROVIDER_LABELS: Readonly<Record<AssistantLlmProvider, string>> = {
  uno: "Uno gateway",
  xai: "xAI",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  custom: "Custom",
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** Harness instance the assistant chat always runs on. */
export const ASSISTANT_HARNESS_INSTANCE_ID = "hermes";
/** Model-selection option carrying {@link AssistantLlmProvider}. */
export const ASSISTANT_LLM_PROVIDER_OPTION_ID = "llmProvider";
/**
 * Default model of the assistant on the Uno gateway: "Smart", the included
 * model of Uno AI hours (the gateway remaps the old default, Grok, to it).
 */
export const ASSISTANT_DEFAULT_GATEWAY_MODEL = "uno/smart";
/**
 * Gateway label of the assistant's calls — the app-label mechanism
 * (`/v1/apps/<label>`, X-Uno-App). Prefixed so a machine app that happens to
 * be called "assistant" doesn't get the assistant's spend in its ledger.
 */
export const ASSISTANT_GATEWAY_LABEL = "uno-assistant";

/** What the daemon tells about one stored key — never the key itself. */
export const AiProviderKeySummary = Schema.Struct({
  provider: ByokProviderId,
  configured: Schema.Boolean,
  /** Last four characters of the key, or null when none is stored. */
  keyHint: Schema.NullOr(Schema.String),
  /** Base URL requests go to (built-in for xai/openrouter/openai). */
  baseUrl: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type AiProviderKeySummary = typeof AiProviderKeySummary.Type;

export const AiProviderKeyList = Schema.Struct({
  keys: Schema.Array(AiProviderKeySummary),
});
export type AiProviderKeyList = typeof AiProviderKeyList.Type;

export const AiProviderKeySetInput = Schema.Struct({
  provider: ByokProviderId,
  apiKey: TrimmedNonEmptyString,
  /** Required for `custom`; ignored for the built-in providers. */
  baseUrl: Schema.optional(TrimmedString),
});
export type AiProviderKeySetInput = typeof AiProviderKeySetInput.Type;

export const AiProviderKeyRemoveInput = Schema.Struct({
  provider: ByokProviderId,
});
export type AiProviderKeyRemoveInput = typeof AiProviderKeyRemoveInput.Type;

/**
 * Test a key: the stored one, or a candidate typed into the form before it is
 * saved (`apiKey` / `baseUrl`).
 */
export const AiProviderKeyTestInput = Schema.Struct({
  provider: ByokProviderId,
  apiKey: Schema.optional(TrimmedString),
  baseUrl: Schema.optional(TrimmedString),
});
export type AiProviderKeyTestInput = typeof AiProviderKeyTestInput.Type;

export const AiProviderKeyTestResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Models `/models` listed (when ok). */
  modelCount: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
export type AiProviderKeyTestResult = typeof AiProviderKeyTestResult.Type;

export const AssistantLlmModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type AssistantLlmModel = typeof AssistantLlmModel.Type;

export const AssistantLlmModelList = Schema.Struct({
  provider: AssistantLlmProvider,
  models: Schema.Array(AssistantLlmModel),
  /** Model a fresh choice of this provider starts on (the latest Grok when there is one). */
  defaultModel: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type AssistantLlmModelList = typeof AssistantLlmModelList.Type;

/**
 * Hermes on this machine, as the assistant needs it:
 * - `ready`       — installed and answering;
 * - `checking`    — the daemon has not probed it yet;
 * - `installing`  — the daemon is installing it (first use);
 * - `missing`     — not installed, no install running (Retry starts one);
 * - `failed`      — the last install failed (`message` says why; Retry);
 * - `unsupported` — cannot be installed here (`message` says why).
 */
export const AssistantHarnessState = Schema.Literals([
  "ready",
  "checking",
  "installing",
  "missing",
  "failed",
  "unsupported",
]);
export type AssistantHarnessState = typeof AssistantHarnessState.Type;

export const AssistantHarnessStatus = Schema.Struct({
  state: AssistantHarnessState,
  message: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** Last lines of the running/failed install, for the progress line. */
  logTail: Schema.NullOr(Schema.String),
});
export type AssistantHarnessStatus = typeof AssistantHarnessStatus.Type;

/**
 * One subscription as the assistant could use it:
 * - `ready`         — signed in, the assistant can run on it now;
 * - `sign-in`       — not signed in on this computer (`signIn` says how);
 * - `needs-hermes`  — this Hermes is too old (Claude needs
 *                     {@link HERMES_CLAUDE_PLUGIN_MIN_VERSION});
 * - `unavailable`   — can't run here (`message` says why).
 */
export const SubscriptionLlmState = Schema.Literals([
  "ready",
  "sign-in",
  "needs-hermes",
  "unavailable",
]);
export type SubscriptionLlmState = typeof SubscriptionLlmState.Type;

export const SubscriptionLlmStatus = Schema.Struct({
  provider: SubscriptionLlmProvider,
  state: SubscriptionLlmState,
  /** "Claude Max", "ChatGPT Plus"… when the sign-in names it. */
  plan: Schema.NullOr(Schema.String),
  /** Who is signed in (email), when known. */
  account: Schema.NullOr(Schema.String),
  /**
   * How to sign in: `harness` — the Claude Code sign-in Uno Work already has
   * (Settings → AI → Agents); `assistant` — the assistant's own ChatGPT
   * sign-in (`POST /api/manager/assistant/llm/sign-in`).
   */
  signIn: Schema.Literals(["harness", "assistant"]),
  message: Schema.NullOr(Schema.String),
});
export type SubscriptionLlmStatus = typeof SubscriptionLlmStatus.Type;

/** A sign-in to the person's ChatGPT for the assistant (Hermes' device code). */
export const AssistantSignInState = Schema.Literals(["waiting", "succeeded", "failed", "idle"]);
export type AssistantSignInState = typeof AssistantSignInState.Type;

export const AssistantSignInStatus = Schema.Struct({
  provider: SubscriptionLlmProvider,
  state: AssistantSignInState,
  /** The page to open ("https://auth.openai.com/codex/device"). */
  url: Schema.NullOr(Schema.String),
  /** The code to type there. */
  code: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type AssistantSignInStatus = typeof AssistantSignInStatus.Type;

export const AssistantSignInInput = Schema.Struct({
  provider: SubscriptionLlmProvider,
});
export type AssistantSignInInput = typeof AssistantSignInInput.Type;

export const AssistantLlmStatus = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  provider: AssistantLlmProvider,
  model: Schema.String,
  harness: AssistantHarnessStatus,
  keys: Schema.Array(AiProviderKeySummary),
  /** The machine has a Uno gateway key (the default path works). */
  gatewayConfigured: Schema.Boolean,
  /**
   * No key yet, but one is on its way (a fresh Uno box: the console writes it
   * seconds after sign-in). A message sent now waits for it. Absent = false.
   */
  gatewayPending: Schema.optionalKey(Schema.Boolean),
  /**
   * The person's subscriptions as the assistant could use them (14.10).
   * Absent: an older daemon that can't run the assistant on them — clients
   * don't offer them then.
   */
  subscriptions: Schema.optionalKey(Schema.Array(SubscriptionLlmStatus)),
});
export type AssistantLlmStatus = typeof AssistantLlmStatus.Type;

export const AssistantLlmSetInput = Schema.Struct({
  provider: AssistantLlmProvider,
  model: TrimmedNonEmptyString,
});
export type AssistantLlmSetInput = typeof AssistantLlmSetInput.Type;
