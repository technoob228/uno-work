import type { OrchestrationSessionErrorClass, ProviderSessionErrorClass } from "@t3tools/contracts";

export const UNO_LLM_CREDITS_EMPTY_MESSAGE = "Uno LLM credits are empty.";

/** Start of the out-of-hours message; the interface recognises it by this. */
export const UNO_AI_HOURS_EMPTY_PREFIX = "Your AI hours are used up.";
const UNO_AI_HOURS_TOP_UP_TAIL = "Top up to keep going on per-token pricing.";

/**
 * The gateway's 402 `ai_hours_empty` (spec ai-hours.md): the month's AI
 * hours and the balance are both spent.
 */
export function isUnoAiHoursEmptyDetail(detail: string | null | undefined): boolean {
  return typeof detail === "string" && /ai_hours_empty|ai hours are used up/i.test(detail);
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
 * "Your AI hours are used up. New hours arrive on Oct 24. Top up to keep
 * going on per-token pricing." — the date from the gateway's own message when
 * it has one.
 */
export function unoAiHoursEmptyMessage(detail: string): string {
  const date = /new hours arrive on\s+([^;\n"]+?)(?:[;"\n]|\.\s|\.$|$)/i.exec(detail)?.[1];
  const renew = date ? ` New hours arrive on ${formatRenewDate(date)}.` : "";
  return `${UNO_AI_HOURS_EMPTY_PREFIX}${renew} ${UNO_AI_HOURS_TOP_UP_TAIL}`;
}

export function isUnoBillingErrorDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  return (
    isUnoAiHoursEmptyDetail(detail) ||
    normalized.includes("402") ||
    normalized.includes("insufficient_balance") ||
    normalized.includes("insufficient balance") ||
    normalized.includes("no_money") ||
    normalized.includes("llm balance") ||
    normalized.includes("llm credits") ||
    normalized.includes("credits depleted") ||
    normalized.includes("workspace_owner_credits_depleted") ||
    normalized.includes("workspace_member_credits_depleted")
  );
}

export function normalizeUnoBillingErrorMessage(detail: string): string {
  if (isUnoAiHoursEmptyDetail(detail)) return unoAiHoursEmptyMessage(detail);
  return isUnoBillingErrorDetail(detail) ? UNO_LLM_CREDITS_EMPTY_MESSAGE : detail;
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
