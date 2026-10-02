import { describe, expect, it } from "vitest";

import {
  classifyOrchestrationErrorDetail,
  classifyProviderErrorDetail,
  isUnoBillingErrorDetail,
  isUnoBillingFailureReply,
  normalizeUnoBillingErrorMessage,
  UNO_AI_CREDIT_EMPTY_MESSAGE,
  UNO_AI_NOT_INCLUDED_MESSAGE,
  UNO_LLM_CREDITS_EMPTY_MESSAGE,
  UNO_PREMIUM_LIMIT_REACHED_MESSAGE,
} from "./unoBilling.ts";

const HOURS_EMPTY =
  "Your AI hours are used up. New hours arrive on Oct 24, 2026; to keep going now, add AI credit at https://console.uno4.dev/billing or switch to your own AI subscription (Claude or ChatGPT).";
const NOT_INCLUDED =
  "Your plan doesn't include Uno AI hours, and your AI credit is empty. Add Uno AI to your plan or top up at https://console.uno4.dev/billing, or switch to your own AI subscription (Claude or ChatGPT).";
const CREDITS_EMPTY =
  "Your AI credit is empty. Top up at https://console.uno4.dev/billing, add Uno AI hours to your plan, or switch to your own AI subscription (Claude or ChatGPT).";
const CREDITS_EMPTY_SMART =
  "Your AI credit is empty. Pick the Smart model (it runs on your AI hours), top up at https://console.uno4.dev/billing, or switch to your own AI subscription (Claude or ChatGPT).";

// One wallet: AI past the hours is paid from the main balance.
const BALANCE_HOURS_EMPTY =
  "Your AI hours are used up. New hours arrive on Oct 24, 2026; to keep going now, top up your balance at https://console.uno4.dev/billing?tab=payments or switch to your own AI subscription (Claude or ChatGPT).";
const BALANCE_NOT_INCLUDED =
  "Your plan doesn't include Uno AI hours, and your balance is empty. Add Uno AI to your plan or top up at https://console.uno4.dev/billing?tab=payments, or switch to your own AI subscription (Claude or ChatGPT).";
const BALANCE_EMPTY =
  "Your balance is empty. Top up at https://console.uno4.dev/billing?tab=payments, add Uno AI hours to your plan, or switch to your own AI subscription (Claude or ChatGPT).";
const BALANCE_EMPTY_SMART =
  "Your balance is empty, and this model is paid per token. Pick the Smart model (it runs on your AI hours), top up at https://console.uno4.dev/billing?tab=payments, or switch to your own AI subscription (Claude or ChatGPT).";
const PREMIUM_MONTH_USED_UP =
  'Your premium credit for this month is used up. Switch to Smart — it is included in your AI hours; new premium credit arrives on Nov 1. To keep using premium models from your balance, turn on "Continue premium from balance".';

const gatewayBody = (code: string, message: string) =>
  JSON.stringify({
    error: { code, type: code, message, billing_url: "https://console.uno4.dev/billing" },
  });

const expectHuman = (text: string) => {
  expect(text).not.toMatch(/HTTP 402|Insufficient LLM credits|[{}]|billing_url/);
};

describe("Uno AI hours used up", () => {
  it("keeps the renew date from the gateway message", () => {
    const detail =
      '402 {"error":{"code":"ai_hours_empty","message":"Your AI hours are used up. New hours arrive on 2026-10-24T02:39:00Z; or top up to keep going."}}';
    expect(classifyProviderErrorDetail(detail)).toBe("billing_error");
    expect(normalizeUnoBillingErrorMessage(detail)).toBe(
      "Your AI hours are used up. New hours arrive on Oct 24. To keep going now, top up your balance at https://console.uno4.dev/billing?tab=payments or switch to your own AI subscription (Claude or ChatGPT).",
    );
  });

  it("keeps a worded date and works without one", () => {
    expect(
      normalizeUnoBillingErrorMessage(
        "ai_hours_empty: Your AI hours are used up. New hours arrive on October 24; or top up.",
      ),
    ).toBe(
      "Your AI hours are used up. New hours arrive on October 24. To keep going now, top up your balance at https://console.uno4.dev/billing?tab=payments or switch to your own AI subscription (Claude or ChatGPT).",
    );
    expect(normalizeUnoBillingErrorMessage("402 ai_hours_empty")).toBe(
      "Your AI hours are used up. To keep going now, top up your balance at https://console.uno4.dev/billing?tab=payments or switch to your own AI subscription (Claude or ChatGPT).",
    );
  });
});

describe("new gateway 402 contract", () => {
  it.each([
    ["ai_hours_empty", HOURS_EMPTY],
    ["ai_not_included", NOT_INCLUDED],
    ["insufficient_credits", CREDITS_EMPTY],
    ["insufficient_credits", CREDITS_EMPTY_SMART],
    ["ai_hours_empty", BALANCE_HOURS_EMPTY],
    ["ai_not_included", BALANCE_NOT_INCLUDED],
    ["insufficient_credits", BALANCE_EMPTY],
    ["insufficient_credits", BALANCE_EMPTY_SMART],
  ])("passes the %s human message through, whatever the wrapping", (code, message) => {
    for (const detail of [
      gatewayBody(code, message),
      `402 ${gatewayBody(code, message)}`,
      `Error code: 402 - ${gatewayBody(code, message)}`,
      // Hermes: `HTTP <status>: <error.message>`.
      `HTTP 402: ${message}`,
      message,
    ]) {
      expect(classifyProviderErrorDetail(detail)).toBe("billing_error");
      expect(classifyOrchestrationErrorDetail(detail)).toBe("billing_error");
      expect(normalizeUnoBillingErrorMessage(detail)).toBe(message);
    }
  });

  it("falls back to the code's own message when the gateway's is cut off", () => {
    // Hermes keeps only the first 300 characters of an error.
    expect(normalizeUnoBillingErrorMessage(`HTTP 402: ${NOT_INCLUDED.slice(0, 120)}`)).toBe(
      UNO_AI_NOT_INCLUDED_MESSAGE,
    );
    expect(
      normalizeUnoBillingErrorMessage(gatewayBody("insufficient_credits", "credit exhausted")),
    ).toBe(UNO_AI_CREDIT_EMPTY_MESSAGE);
    expect(normalizeUnoBillingErrorMessage(gatewayBody("ai_not_included", "no plan ai"))).toBe(
      UNO_AI_NOT_INCLUDED_MESSAGE,
    );
  });

  it("classifies its own output as billing too (lastErrorClass survives normalization)", () => {
    for (const message of [
      UNO_AI_CREDIT_EMPTY_MESSAGE,
      UNO_AI_NOT_INCLUDED_MESSAGE,
      normalizeUnoBillingErrorMessage("402 ai_hours_empty"),
    ]) {
      expect(classifyOrchestrationErrorDetail(message)).toBe("billing_error");
      expect(normalizeUnoBillingErrorMessage(message)).toBe(message);
    }
  });
});

describe("premium limit reached (402 premium_limit_reached)", () => {
  it("shows the gateway's own sentence, with the way out added", () => {
    const detail = `HTTP 402: ${gatewayBody(
      "premium_limit_reached",
      "Premium credit is used up and no AI hours are left for Smart",
    )}`;
    expect(isUnoBillingErrorDetail(detail)).toBe(true);
    expect(classifyProviderErrorDetail(detail)).toBe("billing_error");
    const text = normalizeUnoBillingErrorMessage(detail);
    expect(text).toBe(
      "Premium credit is used up and no AI hours are left for Smart. Manage premium credit at https://console.uno4.dev/billing.",
    );
    expectHuman(text);
  });

  it("keeps a complete gateway sentence and falls back without one", () => {
    const complete =
      "Premium credit is used up. Continue from balance at https://console.uno4.dev/billing.";
    expect(
      normalizeUnoBillingErrorMessage(
        `Error code: 402 - ${gatewayBody("premium_limit_reached", complete)}`,
      ),
    ).toBe(complete);
    expect(
      normalizeUnoBillingErrorMessage(JSON.stringify({ error: { code: "premium_limit_reached" } })),
    ).toBe(UNO_PREMIUM_LIMIT_REACHED_MESSAGE);
    expect(isUnoBillingFailureReply(UNO_PREMIUM_LIMIT_REACHED_MESSAGE)).toBe(true);
  });

  it("keeps the one-wallet monthly wording and adds the way out", () => {
    const detail = `HTTP 402: ${gatewayBody("premium_limit_reached", PREMIUM_MONTH_USED_UP)}`;
    expect(classifyProviderErrorDetail(detail)).toBe("billing_error");
    const text = normalizeUnoBillingErrorMessage(detail);
    expect(text).toBe(
      `${PREMIUM_MONTH_USED_UP} Manage premium credit at https://console.uno4.dev/billing.`,
    );
    expectHuman(text);
    expect(isUnoBillingFailureReply(text)).toBe(true);
  });
});

describe("one-wallet fallbacks", () => {
  it("speak of the balance and point at the payments tab", () => {
    for (const message of [UNO_AI_CREDIT_EMPTY_MESSAGE, UNO_AI_NOT_INCLUDED_MESSAGE]) {
      expect(message).toMatch(/balance is empty/);
      expect(message).toContain("https://console.uno4.dev/billing?tab=payments");
      expect(message).not.toMatch(/AI credit/);
    }
    expect(UNO_AI_CREDIT_EMPTY_MESSAGE.startsWith("Your balance is empty.")).toBe(true);
  });
});

describe("old gateway wording", () => {
  it('turns the exact "HTTP 402: Insufficient LLM credits" into a way out', () => {
    const raw = "HTTP 402: Insufficient LLM credits";
    expect(classifyProviderErrorDetail(raw)).toBe("billing_error");
    const text = normalizeUnoBillingErrorMessage(raw);
    expect(text).toBe(UNO_AI_CREDIT_EMPTY_MESSAGE);
    expectHuman(text);
    expect(text).toContain("https://console.uno4.dev/billing");
    expect(text).toContain("Claude or ChatGPT");
  });

  it.each([
    "Insufficient LLM credits",
    "Error: HTTP 402: Insufficient LLM credits",
    'Error code: 402 - {"error":{"message":"Insufficient LLM credits"}}',
    "Error code: 402 - {'error': {'message': 'Insufficient LLM credits', 'code': 402}}",
  ])("%s", (raw) => {
    expect(classifyProviderErrorDetail(raw)).toBe("billing_error");
    expect(normalizeUnoBillingErrorMessage(raw)).toBe(UNO_AI_CREDIT_EMPTY_MESSAGE);
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

describe("billing failure relayed as an assistant reply", () => {
  it("recognises Hermes' error replies", () => {
    for (const reply of [
      "HTTP 402: Insufficient LLM credits",
      `HTTP 402: ${HOURS_EMPTY}`,
      `HTTP 402: ${NOT_INCLUDED}`,
      "Error: Error code: 402 - {'error': {'message': 'Insufficient LLM credits'}}",
      CREDITS_EMPTY,
      BALANCE_EMPTY,
      BALANCE_EMPTY_SMART,
      `HTTP 402: ${BALANCE_HOURS_EMPTY}`,
      BALANCE_NOT_INCLUDED,
    ]) {
      expect(isUnoBillingFailureReply(reply)).toBe(true);
    }
  });

  it("leaves ordinary replies alone, even ones about billing", () => {
    for (const reply of [
      "Sure! Here is your plan for today.",
      "An HTTP 402 status means Payment Required.",
      "Your AI credit is empty? Let me check the billing page for you.",
      "Your balance is empty? Let me check the billing page for you.",
      "",
    ]) {
      expect(isUnoBillingFailureReply(reply)).toBe(false);
    }
  });
});
