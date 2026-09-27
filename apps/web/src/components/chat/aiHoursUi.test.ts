import type { UnoAiStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { aiBusyNotice } from "../../lib/aiStatusReactQuery";
import { aiBusyNoticeText } from "./AiBusyNotice";
import { isCuratedUnoModelList } from "./ModelPickerContent";
import { UNO_LLM_CREDITS_EMPTY_MESSAGE, unoBillingBannerText } from "./UnoBillingTopUpBanner";

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

  it("never shows a raw gateway error", () => {
    for (const raw of ["HTTP 402: Insufficient LLM credits", "Uno LLM credits are empty."]) {
      const text = unoBillingBannerText(raw);
      expect(text).toBe(UNO_LLM_CREDITS_EMPTY_MESSAGE);
      expect(text).not.toMatch(/HTTP 402|Insufficient LLM credits/);
    }
  });
});
