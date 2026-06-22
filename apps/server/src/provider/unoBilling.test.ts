import { describe, expect, it } from "vitest";

import {
  classifyProviderErrorDetail,
  isUnoBillingErrorDetail,
  normalizeUnoBillingErrorMessage,
  UNO_LLM_CREDITS_EMPTY_MESSAGE,
} from "./unoBilling.ts";

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
