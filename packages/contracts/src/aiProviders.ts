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
 *   as "custom"). Billed by that provider; Uno spend limits don't apply.
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

/** Where the assistant's LLM comes from: the Uno gateway or a stored key. */
export const AssistantLlmProvider = Schema.Literals([
  "uno",
  "xai",
  "openrouter",
  "openai",
  "custom",
]);
export type AssistantLlmProvider = typeof AssistantLlmProvider.Type;

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
};

/** Harness instance the assistant chat always runs on. */
export const ASSISTANT_HARNESS_INSTANCE_ID = "hermes";
/** Model-selection option carrying {@link AssistantLlmProvider}. */
export const ASSISTANT_LLM_PROVIDER_OPTION_ID = "llmProvider";
/** Default model of the assistant on the Uno gateway: the latest Grok. */
export const ASSISTANT_DEFAULT_GATEWAY_MODEL = "~x-ai/grok-latest";
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

export const AssistantLlmStatus = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  provider: AssistantLlmProvider,
  model: Schema.String,
  harness: AssistantHarnessStatus,
  keys: Schema.Array(AiProviderKeySummary),
  /** The machine has a Uno gateway key (the default path works). */
  gatewayConfigured: Schema.Boolean,
});
export type AssistantLlmStatus = typeof AssistantLlmStatus.Type;

export const AssistantLlmSetInput = Schema.Struct({
  provider: AssistantLlmProvider,
  model: TrimmedNonEmptyString,
});
export type AssistantLlmSetInput = typeof AssistantLlmSetInput.Type;
