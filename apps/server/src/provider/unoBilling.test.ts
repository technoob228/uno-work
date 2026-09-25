import { describe, expect, it } from "vitest";

import {
  classifyProviderErrorDetail,
  isUnoBillingErrorDetail,
  normalizeUnoBillingErrorMessage,
  UNO_LLM_CREDITS_EMPTY_MESSAGE,
} from "./unoBilling.ts";

describe("Uno AI hours used up", () => {
  it("keeps the renew date from the gateway message", () => {
    const detail =
      '402 {"error":{"code":"ai_hours_empty","message":"Your AI hours are used up. New hours arrive on 2026-10-24T02:39:00Z; or top up to keep going."}}';
    expect(classifyProviderErrorDetail(detail)).toBe("billing_error");
    expect(normalizeUnoBillingErrorMessage(detail)).toBe(
      "Your AI hours are used up. New hours arrive on Oct 24. Top up to keep going on per-token pricing.",
    );
  });

  it("keeps a worded date and works without one", () => {
    expect(
      normalizeUnoBillingErrorMessage(
        "ai_hours_empty: Your AI hours are used up. New hours arrive on October 24; or top up.",
      ),
    ).toBe(
      "Your AI hours are used up. New hours arrive on October 24. Top up to keep going on per-token pricing.",
    );
    expect(normalizeUnoBillingErrorMessage("402 ai_hours_empty")).toBe(
      "Your AI hours are used up. Top up to keep going on per-token pricing.",
    );
  });
});

describe("Uno billing error normalization", () => {
  it("maps gateway credit failures to billing_error", () => {
    expect(isUnoBillingErrorDetail("402 INSUFFICIENT_BALANCE: llm balance depleted")).toBe(true);
    expect(classifyProviderErrorDetail("NO_MONEY: credits depleted")).toBe("billing_error");
    expect(normalizeUnoBillingErrorMessage("402 workspace has no llm credits")).toBe(
      UNO_LLM_CREDITS_EMPTY_MESSAGE,
    );
  });

  it("leaves generic provider failures as provider_error", () => {
    expect(isUnoBillingErrorDetail("500 upstream timeout")).toBe(false);
    expect(classifyProviderErrorDetail("500 upstream timeout")).toBe("provider_error");
    expect(normalizeUnoBillingErrorMessage("500 upstream timeout")).toBe("500 upstream timeout");
  });
});
