import type { UnoAiStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { aiBusyNotice } from "../../lib/aiStatusReactQuery";
import { aiBusyNoticeText } from "./AiBusyNotice";
import { isCuratedUnoModelList } from "./ModelPickerContent";
import { unoBillingBannerText } from "./UnoBillingTopUpBanner";

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
  it("shows the AI hours message when hours ran out, credits otherwise", () => {
    const hours =
      "Your AI hours are used up. New hours arrive on Oct 24. Top up to keep going on per-token pricing.";
    expect(unoBillingBannerText(hours)).toBe(hours);
    expect(unoBillingBannerText("Uno LLM credits are empty.")).toBe("Uno LLM credits are empty.");
    expect(unoBillingBannerText(null)).toBe("Uno LLM credits are empty.");
  });
});
