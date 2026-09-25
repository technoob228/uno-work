/**
 * Uno AI hours: the short, curated model list of the Uno gateway.
 *
 * A gateway with AI hours marks each model of `/v1/models` with `uno_group`
 * (`included` — Smart / Fast, spent from the plan's AI hours; `premium` —
 * Claude / GPT / Gemini, per token from premium credit) and hides the rest of
 * the catalog. When any model carries the mark the picker trusts it: only the
 * marked models (plus the account's private-GPU models) are shown, in a fixed
 * order. An older gateway sends no marks and everything stays as before.
 *
 * Spec: fishcode `back/knowledge/ai-hours.md`.
 *
 * @module provider/Drivers/unoCuratedModels
 */
import {
  UNO_FAST_GATEWAY_MODEL,
  UNO_FAST_MODEL_SLUG,
  UNO_LEGACY_DEFAULT_MODEL_SLUG,
  UNO_LEGACY_TEXT_GENERATION_MODEL_SLUG,
  UNO_SMART_GATEWAY_MODEL,
  UNO_SMART_MODEL_SLUG,
} from "@t3tools/contracts";

export type UnoCatalogGroup = "included" | "premium";

export function parseUnoCatalogGroup(value: unknown): UnoCatalogGroup | undefined {
  return value === "included" || value === "premium" ? value : undefined;
}

/** Included models first, in this order; then premium in this order. */
const CURATED_ORDER: ReadonlyArray<string> = [
  UNO_SMART_GATEWAY_MODEL,
  UNO_FAST_GATEWAY_MODEL,
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-fable-5.1",
  "openai/gpt-6-sol",
  "openai/gpt-6-astra",
  "google/gemini-3.8-flash",
];
const CURATED_RANK = new Map(CURATED_ORDER.map((id, index) => [id, index]));
const GROUP_RANK: Record<UnoCatalogGroup, number> = { included: 0, premium: 1 };

/** Sort key of a curated model: group, then the fixed order, then unknown ones. */
export function curatedModelRank(gatewayId: string, group: UnoCatalogGroup): number {
  return GROUP_RANK[group] * 1_000 + (CURATED_RANK.get(gatewayId) ?? 999);
}

/**
 * Pre-hours defaults that already-installed Uno Work saved in chats and
 * settings. The gateway remaps them to Smart / Fast for accounts with hours,
 * so the harness must still accept them even though `/v1/models` no longer
 * lists them: they go into the harness config, never into the picker.
 */
export const UNO_LEGACY_HARNESS_MODEL_IDS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "moonshotai/kimi-k2.7-code", name: "Smart" },
  { id: "~deepseek/deepseek-v4-flash-latest", name: "Fast" },
  { id: "~x-ai/grok-latest", name: "Smart" },
];

const UNDERLYING_NAMES: Readonly<Record<string, string>> = {
  "xiaomi/mimo-v2.6-pro": "MiMo-V2.6-Pro",
  "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "z-ai/glm-5.3-flash": "GLM-5.3 Flash",
};

/**
 * `xiaomi/mimo-v2.6-pro` → `MiMo-V2.6-Pro`. The gateway may already send a
 * display form (anything without a slash is kept as is).
 */
export function formatUnderlyingModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  const known = UNDERLYING_NAMES[value.toLowerCase()];
  if (known) return known;
  if (!value.includes("/")) return value;
  const bare = value.slice(value.lastIndexOf("/") + 1);
  return bare
    .split("-")
    .filter(Boolean)
    .map((part) =>
      /^v?\d/i.test(part) ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(" ");
}

/**
 * A default the harness may be asked for that this gateway does not list:
 * Smart / Fast on a gateway without AI hours fall back to the pre-hours
 * defaults, so titles and first chats keep working until the backend ships.
 */
export function resolveUnoDefaultSlug(slug: string, listed: (slug: string) => boolean): string {
  if (listed(slug)) return slug;
  if (slug === UNO_SMART_MODEL_SLUG) return UNO_LEGACY_DEFAULT_MODEL_SLUG;
  if (slug === UNO_FAST_MODEL_SLUG) return UNO_LEGACY_TEXT_GENERATION_MODEL_SLUG;
  return slug;
}
