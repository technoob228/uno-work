/**
 * The Uno assistant's harness + LLM, as a model selection (contracts:
 * aiProviders.ts). Shared by the daemon (which enforces "the assistant chat
 * is always Hermes") and clients (header chip, picker).
 *
 * Pure: no I/O.
 */
import {
  ASSISTANT_DEFAULT_GATEWAY_MODEL,
  ASSISTANT_HARNESS_INSTANCE_ID,
  ASSISTANT_LLM_PROVIDER_OPTION_ID,
  AI_PROVIDER_LABELS,
  type AssistantLlmProvider,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";

const PROVIDERS: ReadonlySet<string> = new Set(Object.keys(AI_PROVIDER_LABELS));

export function isAssistantLlmProvider(value: unknown): value is AssistantLlmProvider {
  return typeof value === "string" && PROVIDERS.has(value);
}

/** The LLM provider a selection names; the Uno gateway when it names none. */
export function readAssistantLlmProvider(
  selection: Pick<ModelSelection, "options"> | null | undefined,
): AssistantLlmProvider {
  const option = selection?.options?.find((entry) => entry.id === ASSISTANT_LLM_PROVIDER_OPTION_ID);
  return isAssistantLlmProvider(option?.value) ? option.value : "uno";
}

export function assistantModelSelection(input: {
  readonly provider: AssistantLlmProvider;
  readonly model: string;
}): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(ASSISTANT_HARNESS_INSTANCE_ID),
    model: input.model,
    options: [{ id: ASSISTANT_LLM_PROVIDER_OPTION_ID, value: input.provider }],
  };
}

export const DEFAULT_ASSISTANT_MODEL_SELECTION: ModelSelection = assistantModelSelection({
  provider: "uno",
  model: ASSISTANT_DEFAULT_GATEWAY_MODEL,
});

export function isAssistantHarnessSelection(
  selection: Pick<ModelSelection, "instanceId"> | null | undefined,
): boolean {
  return selection?.instanceId === ASSISTANT_HARNESS_INSTANCE_ID;
}

/**
 * What the assistant chat runs on, whatever was asked: a Hermes selection is
 * kept (normalised to carry its provider), anything else — another harness
 * the chat used before 0.0.84, or a composer's stale pick — becomes the
 * default (Hermes, latest Grok, Uno gateway).
 */
export function coerceAssistantModelSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection {
  if (!selection || !isAssistantHarnessSelection(selection)) {
    return DEFAULT_ASSISTANT_MODEL_SELECTION;
  }
  return assistantModelSelection({
    provider: readAssistantLlmProvider(selection),
    model: selection.model,
  });
}

export function sameAssistantModelSelection(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    readAssistantLlmProvider(a) === readAssistantLlmProvider(b)
  );
}

function grokVersion(id: string): ReadonlyArray<number> | null {
  const bare = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const match = /^grok-(\d+(?:\.\d+)*)(?:-(\d{4}))?$/.exec(bare);
  if (!match?.[1]) return null;
  // xAI numbers releases as decimals: 4.20 shipped before 4.3 and 4.7
  // (the gateway's `~x-ai/grok-latest` resolves to 4.7), so "4.20" is 4.2.
  const [major = "0", ...rest] = match[1].split(".");
  const decimal = Number.parseFloat(rest.length > 0 ? `${major}.${rest.join("")}` : major);
  // Dated snapshots (`grok-4-0709`) rank below the undated release.
  return [decimal, match[2] ? -1 : 0];
}

/** Release number of a plain Grok id (`x-ai/grok-4.20` → 4.2), null for anything else. */
export function grokReleaseVersion(id: string): number | null {
  const version = grokVersion(id);
  return version === null ? null : (version[0] ?? null);
}

function compareVersions(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest plain Grok in a model list (`x-ai/grok-4.7`, `grok-4.3`, …) —
 * variants (mini, vision, multi-agent, `:batch`) don't count. Null: no Grok.
 */
export function pickLatestGrokModel(ids: ReadonlyArray<string>): string | null {
  let best: { readonly id: string; readonly version: ReadonlyArray<number> } | null = null;
  for (const id of ids) {
    const version = grokVersion(id);
    if (version === null) continue;
    if (best === null || compareVersions(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? null;
}

/**
 * Model a fresh choice of a provider starts on: the latest Grok wherever there
 * is one (the gateway and OpenRouter have a `~x-ai/grok-latest` alias that
 * follows new releases), else the provider's first model.
 */
export function defaultAssistantModelFor(
  provider: AssistantLlmProvider,
  modelIds: ReadonlyArray<string>,
): string | null {
  if (provider === "uno") return ASSISTANT_DEFAULT_GATEWAY_MODEL;
  if (provider === "openrouter" && modelIds.includes(ASSISTANT_DEFAULT_GATEWAY_MODEL)) {
    return ASSISTANT_DEFAULT_GATEWAY_MODEL;
  }
  if (provider === "xai" && modelIds.includes("grok-latest")) return "grok-latest";
  return pickLatestGrokModel(modelIds) ?? modelIds[0] ?? null;
}

/** "~x-ai/grok-latest" → "Grok (latest)", "x-ai/grok-4.7" → "Grok 4.7", "openai/gpt-5" → "gpt-5". */
export function assistantModelLabel(model: string): string {
  const bare = model.slice(model.lastIndexOf("/") + 1);
  if (/^grok-latest$/i.test(bare)) return "Grok (latest)";
  const grok = /^grok-(.+)$/i.exec(bare);
  if (grok?.[1]) return `Grok ${grok[1]}`;
  return bare;
}

/** Short provider label for the chat header: "Uno gateway" / "Your xAI key". */
export function assistantProviderLabel(provider: AssistantLlmProvider): string {
  return provider === "uno"
    ? AI_PROVIDER_LABELS.uno
    : provider === "custom"
      ? "Your key (custom)"
      : `Your ${AI_PROVIDER_LABELS[provider]} key`;
}

/** Last four characters of a secret, for display. */
export function secretKeyHint(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? "••••" : trimmed.slice(-4);
}

/**
 * The harness the account's default AI means on a machine (console
 * `GET /auth/me` `default_ai`, picked in onboarding). "byok" has no harness
 * of its own: OpenCode takes the key (as in the setup's AI step). Null for
 * anything unknown.
 */
export function harnessForAccountDefaultAi(value: unknown): string | null {
  switch (value) {
    case "uno":
      return "uno";
    case "claude":
      return "claudeAgent";
    case "codex":
      return "codex";
    case "opencode":
    case "byok":
      return "opencode";
    default:
      return null;
  }
}
