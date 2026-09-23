/**
 * What an app's call cost, so its limit means something.
 *
 * The daemon forwards an app's calls with the machine's AI key, so the
 * gateway bills the machine; the daemon keeps the per-app ledger. The answer
 * is taken, in order of precision, from:
 *
 * 1. `x_uno.cost_usd` — the billed amount, when the gateway reports it;
 * 2. `usage.cost` — the provider cost OpenRouter passes through, times the
 *    gateway markup (what the gateway bills in that case);
 * 3. tokens × the model's prices from `GET /v1/models`;
 * 4. tokens × conservative fallback prices (unknown model).
 */

/** Gateway markup on provider-reported cost (fishcode `openRouterBillingMarkup`). */
export const GATEWAY_PROVIDER_COST_MARKUP = 1.15;
/** Per token, when a model's price is unknown: deliberately on the expensive side. */
export const FALLBACK_PROMPT_PRICE = 3 / 1_000_000;
export const FALLBACK_COMPLETION_PRICE = 15 / 1_000_000;
/** The gateway never bills a transcription above hold × 2. */
export const TRANSCRIPTION_MAX_USD = 0.04;
const TRANSCRIPTION_USD_PER_MINUTE = 0.006 * GATEWAY_PROVIDER_COST_MARKUP;
/** ~1 MB per audio minute is a fair middle for voice codecs. */
const TRANSCRIPTION_BYTES_PER_MINUTE = 1024 * 1024;

export interface ModelPrice {
  readonly prompt: number;
  readonly completion: number;
}

export interface ChatUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly providerCost: number | null;
  readonly billedCost: number | null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Reads `usage` / `x_uno` from a completion (or the final stream chunk). */
export function usageFromPayload(payload: unknown): ChatUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const usage = record["usage"] as Record<string, unknown> | undefined;
  const xUno = record["x_uno"] as Record<string, unknown> | undefined;
  const billed = num(xUno?.["cost_usd"]);
  if (!usage && billed === null) return null;
  const details = usage?.["cost_details"] as Record<string, unknown> | undefined;
  const providerCost = num(usage?.["cost"]) ?? num(details?.["upstream_inference_cost"]);
  return {
    promptTokens: num(usage?.["prompt_tokens"]) ?? 0,
    completionTokens: num(usage?.["completion_tokens"]) ?? 0,
    providerCost: providerCost !== null && providerCost > 0 ? providerCost : null,
    billedCost: billed,
  };
}

export function chatCostUsd(usage: ChatUsage, price: ModelPrice | undefined): number {
  if (usage.billedCost !== null) return usage.billedCost;
  if (usage.providerCost !== null) return usage.providerCost * GATEWAY_PROVIDER_COST_MARKUP;
  const p = price ?? { prompt: FALLBACK_PROMPT_PRICE, completion: FALLBACK_COMPLETION_PRICE };
  return usage.promptTokens * p.prompt + usage.completionTokens * p.completion;
}

/** When the answer carried no usage at all (an aborted stream): charge by size. */
export function estimateChatCostFromChars(
  promptChars: number,
  completionChars: number,
  price: ModelPrice | undefined,
): number {
  const p = price ?? { prompt: FALLBACK_PROMPT_PRICE, completion: FALLBACK_COMPLETION_PRICE };
  return Math.ceil(promptChars / 4) * p.prompt + Math.ceil(completionChars / 4) * p.completion;
}

export function transcriptionCostUsd(input: {
  readonly audioBytes: number;
  readonly durationSeconds: number | null;
}): number {
  const minutes =
    input.durationSeconds !== null
      ? input.durationSeconds / 60
      : input.audioBytes / TRANSCRIPTION_BYTES_PER_MINUTE;
  return Math.min(TRANSCRIPTION_MAX_USD, Math.max(0.001, minutes * TRANSCRIPTION_USD_PER_MINUTE));
}

/** `GET /v1/models` → id → per-token prices (entries without known prices are skipped). */
export function parseModelPrices(payload: unknown): Map<string, ModelPrice> {
  const prices = new Map<string, ModelPrice>();
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return prices;
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const pricing = record["pricing"] as Record<string, unknown> | undefined;
    const prompt = num(pricing?.["prompt"]);
    const completion = num(pricing?.["completion"]);
    if (typeof id !== "string" || prompt === null || completion === null) continue;
    prices.set(id, { prompt, completion });
  }
  return prices;
}

/**
 * Incremental SSE reader: feed raw chunks, get back the usage from the last
 * chunk that carried one, and how much text was streamed.
 */
export function makeSseUsageTracker() {
  let buffer = "";
  let usage: ChatUsage | null = null;
  let contentChars = 0;
  const line = (raw: string) => {
    const trimmed = raw.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]" || data.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const found = usageFromPayload(payload);
    if (found) usage = found;
    const choices = (payload as { choices?: unknown }).choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const content = (choice as { delta?: { content?: unknown } })?.delta?.content;
        if (typeof content === "string") contentChars += content.length;
      }
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    finish() {
      if (buffer.length > 0) line(buffer);
      buffer = "";
      return { usage, contentChars };
    },
  };
}
