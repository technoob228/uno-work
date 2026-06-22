import type { OrchestrationSessionErrorClass, ProviderSessionErrorClass } from "@t3tools/contracts";

export const UNO_LLM_CREDITS_EMPTY_MESSAGE = "Uno LLM credits are empty.";

export function isUnoBillingErrorDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  return (
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
