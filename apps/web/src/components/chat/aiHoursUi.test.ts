import type { UnoAiStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { aiBusyNotice } from "../../lib/aiStatusReactQuery";
import { aiBusyNoticeText } from "./AiBusyNotice";
import {
  isCuratedUnoModelList,
  showUnoPremiumComingSoon,
  UNO_PREMIUM_COMING_SOON_TEXT,
} from "./ModelPickerContent";
import { unoGatewayModelId } from "./unoModelIds";
import { UNO_LLM_CREDITS_EMPTY_MESSAGE, unoBillingBannerText } from "./UnoBillingTopUpBanner";
import {
  isUnoPremiumModelSelected,
  premiumCreditHeading,
  premiumFallbackNotice,
} from "./PremiumCreditNotice";

const status = (over: Partial<UnoAiStatus> = {}): UnoAiStatus => ({
  status: "ok",
  hoursLeftMinutes: 5220,
  unlimited: false,
  fullSpeedHoursLeft: null,
  usedTodayMinutes: 47,
  power: 1,
  inFlight: 3,
  throttled: false,
  speedPct: 100,
  renewsAt: "2026-10-24T02:39:00Z",
  plan: "small-ai",
  checkedAt: null,
  ...over,
});

describe("AI busy notice", () => {
  it("says nothing at full speed or without AI hours", () => {
    expect(aiBusyNotice(status())).toBeNull();
    expect(aiBusyNotice(null)).toBeNull();
  });

  it("one calm line while slowed down, with the way to more power", () => {
    const notice = aiBusyNotice(status({ throttled: true, speedPct: 40 }))!;
    expect(aiBusyNoticeText(notice)).toEqual({
      text: "AI is busy, tasks run a bit slower.",
      link: "More AI power on bigger plans →",
    });
  });

  it("unlimited plans past the full-speed hours run at standard speed until renewal", () => {
    const notice = aiBusyNotice(
      status({ unlimited: true, hoursLeftMinutes: null, fullSpeedHoursLeft: 0, throttled: true }),
    )!;
    expect(notice.kind).toBe("standard-speed");
    const { text, link } = aiBusyNoticeText(notice);
    expect(text).toMatch(
      /^You've used this month's full-speed hours — AI keeps working at standard speed until .+\.$/,
    );
    expect(link).toBeNull();
  });

  it("Fast-unlimited plans past the Smart hours: Fast keeps going at standard speed", () => {
    const notice = aiBusyNotice(
      status({ hoursLeftMinutes: 0, fastUnlimited: true, fastStandardSpeed: true }),
    )!;
    expect(notice.kind).toBe("fast-standard");
    expect(aiBusyNoticeText(notice)).toEqual({
      text: "Your AI time is used up. Fast keeps going at standard speed.",
      link: null,
    });
    // An older daemon doesn't send the flag: as before.
    expect(aiBusyNotice(status({ hoursLeftMinutes: 0 }))).toBeNull();
  });
});

const meta = (unoGroup?: "included" | "premium" | "personal") => ({
  capabilities: { metadata: unoGroup ? { unoGroup } : {} },
});

describe("curated Uno model list", () => {
  it("is on only when the gateway marks Smart/Fast or premium", () => {
    expect(isCuratedUnoModelList([{ driverKind: "uno" as never, ...meta("included") }])).toBe(true);
    expect(isCuratedUnoModelList([{ driverKind: "uno" as never, ...meta("personal") }])).toBe(
      false,
    );
    expect(isCuratedUnoModelList([{ driverKind: "uno" as never, ...meta() }])).toBe(false);
    expect(isCuratedUnoModelList([{ driverKind: "codex" as never, ...meta("premium") }])).toBe(
      false,
    );
  });
});

describe("premium coming-soon caption", () => {
  const uno = (slug: string, group?: "included" | "premium" | "personal") => ({
    slug,
    driverKind: "uno" as never,
    ...meta(group),
  });

  it("closes the Premium group while Claude / GPT / Gemini are not in it", () => {
    expect(UNO_PREMIUM_COMING_SOON_TEXT).toBe("Claude, GPT and Gemini — coming soon");
    expect(
      showUnoPremiumComingSoon([
        uno("uno/smart", "included"),
        uno("moonshotai/kimi-k3", "premium"),
        uno("x-ai/grok-4.7", "premium"),
        uno("z-ai/glm-5.3", "premium"),
      ]),
    ).toBe(true);
  });

  it("disappears once the gateway lists any of them as premium", () => {
    for (const slug of ["anthropic/claude-sonnet-5", "openai/gpt-6", "google/gemini-3.5-pro"]) {
      expect(
        showUnoPremiumComingSoon([uno("x-ai/grok-4.7", "premium"), uno(slug, "premium")]),
      ).toBe(false);
    }
  });

  it("disappears under Uno Code too, whose slugs carry the harness provider", () => {
    for (const slug of [
      "uno/anthropic/claude-opus-5.5",
      "uno/openai/gpt-6-sol",
      "uno-russia/google/gemini-3.8-flash",
    ]) {
      expect(
        showUnoPremiumComingSoon([uno("uno/x-ai/grok-4.7", "premium"), uno(slug, "premium")]),
      ).toBe(false);
    }
    // Hermes lists gateway ids.
    const hermes = (slug: string) => ({ slug, driverKind: "hermes" as never, ...meta("premium") });
    expect(showUnoPremiumComingSoon([hermes("anthropic/claude-sonnet-5")])).toBe(false);
    expect(showUnoPremiumComingSoon([hermes("z-ai/glm-5.3")])).toBe(true);
    expect(
      showUnoPremiumComingSoon([
        uno("uno/x-ai/grok-4.7", "premium"),
        uno("uno/z-ai/glm-5.3", "premium"),
      ]),
    ).toBe(true);
  });

  it("strips only the harness provider from a slug", () => {
    expect(unoGatewayModelId("uno/anthropic/claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
    expect(unoGatewayModelId("uno-russia/openai/gpt-6-sol")).toBe("openai/gpt-6-sol");
    expect(unoGatewayModelId("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(unoGatewayModelId("uno/uno/smart")).toBe("uno/smart");
  });

  it("stays off without a Premium group", () => {
    expect(showUnoPremiumComingSoon([uno("uno/smart", "included")])).toBe(false);
    expect(
      showUnoPremiumComingSoon([
        { slug: "x-ai/grok-4.7", driverKind: "codex" as never, ...meta("premium") },
      ]),
    ).toBe(false);
  });
});

const premium = (over: Partial<NonNullable<UnoAiStatus["premium"]>> = {}) => ({
  limited: true,
  limitUsd: 30,
  leftUsd: 23.4,
  monthlyUsd: 30,
  overage: false,
  balanceUsd: 0,
  renewsAt: "2026-10-24T02:39:00Z",
  exhausted: false,
  ...over,
});

const caps = (unoGroup?: "included" | "premium" | "personal") =>
  ({ optionDescriptors: [], metadata: unoGroup ? { unoGroup } : {} }) as never;

describe("premium credit", () => {
  it("says the premium model is answered by Smart, with the way to keep it", () => {
    const notice = premiumFallbackNotice(
      status({ premium: premium({ exhausted: true, leftUsd: 0 }) }),
      true,
    );
    expect(notice).toEqual({
      text: "Answered by Smart: no Premium credit. New credit on Oct 24.",
      actionLabel: "Continue from balance",
      actionUrl: "https://console.uno.place/billing#premium",
    });
    expect(
      premiumFallbackNotice(
        status({ premium: premium({ exhausted: true, renewsAt: null }), renewsAt: null }),
        true,
      )?.text,
    ).toBe("Answered by Smart: no Premium credit. New credit arrives when your plan renews.");
  });

  it("says nothing on Smart / Fast, with credit left, or without the premium field", () => {
    expect(
      premiumFallbackNotice(status({ premium: premium({ exhausted: true }) }), false),
    ).toBeNull();
    expect(premiumFallbackNotice(status({ premium: premium() }), true)).toBeNull();
    expect(premiumFallbackNotice(status(), true)).toBeNull();
    expect(premiumFallbackNotice(null, true)).toBeNull();
  });

  it("puts the credit left into the Premium heading", () => {
    expect(premiumCreditHeading(premium())).toBe("Premium · $23.40 of $30 left");
    expect(premiumCreditHeading(premium({ monthlyUsd: null, limitUsd: null, leftUsd: 5 }))).toBe(
      "Premium · $5 left",
    );
    expect(premiumCreditHeading(premium({ leftUsd: null }))).toBeNull();
    expect(premiumCreditHeading(null)).toBeNull();
  });

  it("knows a premium pick under both Uno harnesses", () => {
    expect(
      isUnoPremiumModelSelected({
        driverKind: "uno",
        slug: "uno/anthropic/claude-opus-5.5",
        capabilities: caps("premium"),
      }),
    ).toBe(true);
    expect(
      isUnoPremiumModelSelected({ driverKind: "hermes", slug: "anthropic/claude-sonnet-5" }),
    ).toBe(true);
    expect(isUnoPremiumModelSelected({ driverKind: "hermes", slug: "uno/smart" })).toBe(false);
    expect(isUnoPremiumModelSelected({ driverKind: "uno", slug: "uno/uno/fast" })).toBe(false);
    expect(
      isUnoPremiumModelSelected({
        driverKind: "uno",
        slug: "uno/uno/smart",
        capabilities: caps("included"),
      }),
    ).toBe(false);
    expect(isUnoPremiumModelSelected({ driverKind: "uno", slug: "uno-personal/qwen" })).toBe(false);
    expect(isUnoPremiumModelSelected({ driverKind: "claudeAgent", slug: "claude-opus-5-5" })).toBe(
      false,
    );
  });
});

describe("top-up banner", () => {
  it("shows the server's billing sentence, the credit message otherwise", () => {
    const hours =
      "Your AI hours are used up. New hours arrive on Oct 24, 2026; to keep going now, add AI credit at https://console.uno4.dev/billing or switch to your own AI subscription (Claude or ChatGPT).";
    expect(unoBillingBannerText(hours)).toBe(hours);
    const notIncluded =
      "Your plan doesn't include Uno AI hours, and your AI credit is empty. Add Uno AI to your plan or top up at https://console.uno4.dev/billing, or switch to your own AI subscription (Claude or ChatGPT).";
    expect(unoBillingBannerText(notIncluded)).toBe(notIncluded);
    expect(unoBillingBannerText(UNO_LLM_CREDITS_EMPTY_MESSAGE)).toBe(UNO_LLM_CREDITS_EMPTY_MESSAGE);
    expect(unoBillingBannerText(null)).toBe(UNO_LLM_CREDITS_EMPTY_MESSAGE);
  });

  it("shows the one-wallet balance sentences as they are", () => {
    expect(UNO_LLM_CREDITS_EMPTY_MESSAGE).toContain(
      "https://console.uno.place/billing?tab=payments",
    );
    for (const message of [
      "Your balance is empty. Top up at https://console.uno4.dev/billing?tab=payments, add Uno AI hours to your plan, or switch to your own AI subscription (Claude or ChatGPT).",
      "Your balance is empty, and this model is paid per token. Pick the Smart model (it runs on your AI hours), top up at https://console.uno4.dev/billing?tab=payments, or switch to your own AI subscription (Claude or ChatGPT).",
      "Your plan doesn't include Uno AI hours, and your balance is empty. Add Uno AI to your plan or top up at https://console.uno4.dev/billing?tab=payments, or switch to your own AI subscription (Claude or ChatGPT).",
      "Your AI hours are used up. New hours arrive on Oct 24, 2026; to keep going now, top up your balance at https://console.uno4.dev/billing?tab=payments or switch to your own AI subscription (Claude or ChatGPT).",
      'Your premium credit for this month is used up. Switch to Smart — it is included in your AI hours; new premium credit arrives on Nov 1. To keep using premium models from your balance, turn on "Continue premium from balance".',
      "Your balance is empty. Top up at https://console.uno.place/billing?tab=payments, add Uno AI hours to your plan, or switch to your own AI subscription (Claude or ChatGPT).",
    ]) {
      expect(unoBillingBannerText(message)).toBe(message);
    }
  });

  it("shows the premium-limit sentence the server passed through", () => {
    const premiumLimit =
      "Premium credit is used up and no AI hours are left for Smart. Manage premium credit at https://console.uno4.dev/billing.";
    expect(unoBillingBannerText(premiumLimit)).toBe(premiumLimit);
    const premiumLimitNewHost = premiumLimit.replace("console.uno4.dev", "console.uno.place");
    expect(unoBillingBannerText(premiumLimitNewHost)).toBe(premiumLimitNewHost);
    expect(unoBillingBannerText('HTTP 402: {"error":{"code":"premium_limit_reached"}}')).toBe(
      UNO_LLM_CREDITS_EMPTY_MESSAGE,
    );
  });

  it("never shows a raw gateway error", () => {
    for (const raw of ["HTTP 402: Insufficient LLM credits", "Uno LLM credits are empty."]) {
      const text = unoBillingBannerText(raw);
      expect(text).toBe(UNO_LLM_CREDITS_EMPTY_MESSAGE);
      expect(text).not.toMatch(/HTTP 402|Insufficient LLM credits/);
    }
  });
});
