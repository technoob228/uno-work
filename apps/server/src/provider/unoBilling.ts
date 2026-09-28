import type { OrchestrationSessionErrorClass, ProviderSessionErrorClass } from "@t3tools/contracts";

/**
 * Uno LLM gateway billing failures (HTTP 402) → one human sentence with a
 * way out. The gateway answers
 * `{"error":{"code":"ai_hours_empty"|"ai_not_included"|"insufficient_credits","message":"<human text>","billing_url":…}}`;
 * harnesses relay it in their own wrapping (Hermes: `HTTP 402: <message>`,
 * the OpenAI SDK: `Error code: 402 - {…}`, OpenCode: the JSON body), and old
 * gateways still say "Insufficient LLM credits". Nothing of that wrapping may
 * reach a person — not in the chat, not in Telegram.
 */

export const UNO_BILLING_URL = "https://console.uno4.dev/billing";
const OWN_SUBSCRIPTION = "switch to your own AI subscription (Claude or ChatGPT)";

/** No AI hours in play (or hours unknown) and the AI credit is spent. */
export const UNO_AI_CREDIT_EMPTY_MESSAGE = `Your AI credit is empty. Top up at ${UNO_BILLING_URL}, add Uno AI hours to your plan, or ${OWN_SUBSCRIPTION}.`;
/** Kept under its old name: the generic "out of credit" message. */
export const UNO_LLM_CREDITS_EMPTY_MESSAGE = UNO_AI_CREDIT_EMPTY_MESSAGE;
/** The gateway's `ai_not_included`: the plan has no Uno AI hours and no credit is left. */
export const UNO_AI_NOT_INCLUDED_MESSAGE = `Your plan doesn't include Uno AI hours, and your AI credit is empty. Add Uno AI to your plan or top up at ${UNO_BILLING_URL}, or ${OWN_SUBSCRIPTION}.`;

/** Start of the out-of-hours message; the interface recognises it by this. */
export const UNO_AI_HOURS_EMPTY_PREFIX = "Your AI hours are used up.";
const UNO_AI_HOURS_TOP_UP_TAIL = `To keep going now, add AI credit at ${UNO_BILLING_URL} or ${OWN_SUBSCRIPTION}.`;

/**
 * The gateway's 402 `premium_limit_reached`: the premium credit is used up,
 * "continue from balance" is off and there are no AI hours left for Smart
 * to answer instead.
 */
export const UNO_PREMIUM_LIMIT_REACHED_MESSAGE = `Your premium credit is used up, and there are no AI hours left to answer with Smart. Turn on "Continue from balance" or add AI hours at ${UNO_BILLING_URL}.`;

type UnoBillingKind =
  | "ai_hours_empty"
  | "ai_not_included"
  | "insufficient_credits"
  | "premium_limit_reached";

function isUnoPremiumLimitDetail(detail: string): boolean {
  return /premium_limit_reached/i.test(detail);
}

/**
 * The gateway's 402 `ai_hours_empty` (spec ai-hours.md): the month's AI
 * hours and the balance are both spent.
 */
export function isUnoAiHoursEmptyDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && /ai_hours_empty|ai hours are used up/i.test(detail);
}

function isUnoAiNotIncludedDetail(detail: string): boolean {
  return /ai_not_included|plan doesn.t include uno ai/i.test(detail);
}

/** "2026-10-24T02:39:00Z" → "Oct 24"; any other wording is kept as it came. */
function formatRenewDate(raw: string): string {
  const trimmed = raw.trim().replace(/[.;,]+$/, "");
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(at);
    }
  }
  return trimmed;
}

/**
 * "Your AI hours are used up. New hours arrive on Oct 24. To keep going now,
 * add AI credit at … or switch to your own AI subscription …" — the date from
 * the gateway's own message when it has one.
 */
export function unoAiHoursEmptyMessage(detail: string): string {
  const date = /new hours arrive on\s+([^;\n"']+?)(?:[;"'\n]|\.\s|\.$|$)/i.exec(detail)?.[1];
  const renew = date ? ` New hours arrive on ${formatRenewDate(date)}.` : "";
  return `${UNO_AI_HOURS_EMPTY_PREFIX}${renew} ${UNO_AI_HOURS_TOP_UP_TAIL}`;
}

export function isUnoBillingErrorDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  return (
    isUnoAiHoursEmptyDetail(detail) ||
    isUnoAiNotIncludedDetail(detail) ||
    isUnoPremiumLimitDetail(detail) ||
    normalized.includes("402") ||
    normalized.includes("insufficient_credits") ||
    normalized.includes("insufficient_balance") ||
    normalized.includes("insufficient balance") ||
    normalized.includes("no_money") ||
    normalized.includes("llm balance") ||
    normalized.includes("llm credits") ||
    normalized.includes("ai credit is empty") ||
    normalized.includes("credits depleted") ||
    normalized.includes("workspace_owner_credits_depleted") ||
    normalized.includes("workspace_member_credits_depleted")
  );
}

/** Harness wrappings in front of the gateway's words. */
const WRAPPER_PREFIX =
  /^\s*(?:error\s*:\s*|error code\s*:?\s*402\s*[-:]?\s*|http\s+402\b\s*[:\-—]?\s*|402\b\s*[:\-—]?\s*)/i;

function stripWrappers(detail: string): string {
  let text = detail;
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(WRAPPER_PREFIX, "");
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** `code` and `message` of the gateway's error body, wherever it sits in `detail`. */
function parseGatewayError(detail: string): { code?: string; message?: string } {
  const start = detail.indexOf("{");
  const end = detail.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(detail.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const inner =
          record.error && typeof record.error === "object"
            ? (record.error as Record<string, unknown>)
            : record;
        const code = readString(inner.code) ?? readString(inner.type);
        const message = readString(inner.message);
        return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
      }
    } catch {
      // Python dict repr (`{'error': {'message': '…'}}`) and cut-off bodies.
    }
  }
  const code = /["']code["']\s*:\s*["']([a-z_]+)["']/i.exec(detail)?.[1];
  const message =
    /["']message["']\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail)?.[1] ??
    /["']message["']\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(detail)?.[1];
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function billingKind(detail: string, code: string | undefined): UnoBillingKind {
  if (
    code === "ai_hours_empty" ||
    code === "ai_not_included" ||
    code === "insufficient_credits" ||
    code === "premium_limit_reached"
  ) {
    return code;
  }
  if (isUnoPremiumLimitDetail(detail)) return "premium_limit_reached";
  if (isUnoAiHoursEmptyDetail(detail)) return "ai_hours_empty";
  if (isUnoAiNotIncludedDetail(detail)) return "ai_not_included";
  return "insufficient_credits";
}

/**
 * The gateway's own sentence is already written for people when it points at
 * the billing page, carries no JSON and was not cut off (Hermes keeps only
 * the first 300 characters of an error).
 */
function isCompleteHumanBillingMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 800 &&
    !/[{}]/.test(trimmed) &&
    !/\bhttp\s+\d{3}\b/i.test(trimmed) &&
    !/insufficient llm credits/i.test(trimmed) &&
    /console\.uno4\.dev\/billing/i.test(trimmed) &&
    /[.!?)]$/.test(trimmed)
  );
}

/** A human sentence (no JSON, no HTTP status), fit to be shown as it is. */
function isPlainSentence(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 600 &&
    !/[{}]/.test(trimmed) &&
    !/\bhttp\s+\d{3}\b/i.test(trimmed) &&
    !/premium_limit_reached/i.test(trimmed)
  );
}

export function normalizeUnoBillingErrorMessage(detail: string): string {
  if (!isUnoBillingErrorDetail(detail)) return detail;
  const gateway = parseGatewayError(detail);
  const human = gateway.message ?? stripWrappers(detail);
  if (isCompleteHumanBillingMessage(human)) return human.trim();
  const kind = billingKind(detail, gateway.code);
  // The premium limit: the gateway's own sentence, with the way out added
  // when it doesn't point at the billing page itself.
  if (kind === "premium_limit_reached" && gateway.message && isPlainSentence(gateway.message)) {
    const sentence = gateway.message.trim().replace(/([^.!?])$/, "$1.");
    return /console\.uno4\.dev\/billing/i.test(sentence)
      ? sentence
      : `${sentence} Manage premium credit at ${UNO_BILLING_URL}.`;
  }
  switch (kind) {
    case "premium_limit_reached":
      return UNO_PREMIUM_LIMIT_REACHED_MESSAGE;
    case "ai_hours_empty":
      return unoAiHoursEmptyMessage(detail);
    case "ai_not_included":
      return UNO_AI_NOT_INCLUDED_MESSAGE;
    case "insufficient_credits":
      return UNO_AI_CREDIT_EMPTY_MESSAGE;
  }
}

/**
 * An assistant *reply* that is really a gateway billing failure: Hermes turns
 * a non-retryable 402 into the turn's final text (`HTTP 402: <message>`) and
 * ends the turn normally. Strict on purpose — a reply that merely talks
 * about billing is not one.
 */
export function isUnoBillingFailureReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 1200) return false;
  if (/^(?:error\s*:\s*)?(?:error code\s*:?\s*)?(?:http\s+)?402\b/i.test(trimmed)) return true;
  if (
    /^(?:error\s*:\s*)?(?:insufficient llm credits|ai_hours_empty|ai_not_included|insufficient_credits|premium_limit_reached)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return (
    /^(?:your ai hours are used up|your plan doesn.t include uno ai hours|your ai credit is empty|your premium credit is used up)/i.test(
      trimmed,
    ) && /console\.uno4\.dev\/billing/i.test(trimmed)
  );
}

/**
 * A billing failure that can only have come from the Uno gateway (its error
 * codes or its billing page). Stricter than {@link isUnoBillingErrorDetail}:
 * used where the harness may also run on the person's own account (Claude
 * Code on Uno AI vs. their own subscription), so a bare "402" doesn't count.
 */
export function isUnoGatewayBillingDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return /premium_limit_reached|ai_hours_empty|ai_not_included|insufficient_credits|console\.uno4\.dev\/billing|your ai hours are used up|your premium credit is used up/i.test(
    detail,
  );
}

export function classifyProviderErrorDetail(
  detail: string | null | undefined,
): ProviderSessionErrorClass {
  return isUnoBillingErrorDetail(detail) ? "billing_error" : "provider_error";
}

export function classifyOrchestrationErrorDetail(
  detail: string | null | undefined,
): OrchestrationSessionErrorClass {
  return isUnoBillingErrorDetail(detail) ? "billing_error" : "provider_error";
}
