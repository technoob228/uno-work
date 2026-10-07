import { describe, expect, it } from "vitest";

import { parsePlanCatalog, parseSubscription, type AccountBalance } from "./accountOverview";
import {
  aiFastLine,
  aiHoursCaption,
  aiHoursHeadline,
  aiHoursLine,
  aiHoursSummary,
  aiTimeNote,
  aiHoursTodayLine,
  formatAiMinutes,
  planAiHoursLine,
  planHasUnoAi,
} from "./aiHours";
import { formatUsd, planLadder, planTitle } from "./billingModel";

const balance = (over: Partial<AccountBalance> = {}): AccountBalance => ({
  email: null,
  username: null,
  name: null,
  balanceUsd: 10,
  aiBalanceUsd: 0,
  aiHoursMinutes: null,
  onboardingPath: null,
  ...over,
});

const subscriptionWithHours = parseSubscription({
  plan: "small-ai",
  ai_hours: {
    balance_minutes: 5220,
    monthly_hours: 40,
    used_this_period_minutes: 180,
    used_today_minutes: 47,
    never_expire: true,
    expires_at: null,
  },
  ai_power: { multiplier: 1, usd_per_hour: 0.5 },
});

describe("formatAiMinutes", () => {
  it("hours, minutes under an hour", () => {
    expect(formatAiMinutes(5220)).toBe("87 h");
    expect(formatAiMinutes(47)).toBe("47 min");
    expect(formatAiMinutes(90)).toBe("1 h 30 min");
    expect(formatAiMinutes(-3)).toBe("0 min");
  });
});

describe("aiHoursSummary", () => {
  it("reads hours from the subscription", () => {
    const summary = aiHoursSummary({
      subscription: subscriptionWithHours,
      balance: balance({ aiBalanceUsd: 12.4 }),
    })!;
    expect(summary).toMatchObject({
      unlimited: false,
      leftMinutes: 5220,
      monthlyHours: 40,
      usedTodayMinutes: 47,
      power: 1,
    });
    expect(aiHoursLine(summary, formatUsd)).toBe(
      "AI time: 87 h left · never expires · $12.40 premium credit",
    );
    expect(aiHoursTodayLine(summary)).toBe("Today: 47 min");
  });

  it("unlimited plans read as Unlimited AI", () => {
    const sub = parseSubscription({
      plan: "max-ai",
      ai_hours: { unlimited: true, balance_minutes: null, monthly_hours: 300 },
    });
    const summary = aiHoursSummary({ subscription: sub, balance: balance() })!;
    expect(summary.unlimited).toBe(true);
    expect(aiHoursLine(summary, formatUsd)).toBe("Unlimited AI");
  });

  it("falls back to /auth/me, and to nothing (credits display) without hours", () => {
    expect(
      aiHoursSummary({ subscription: null, balance: balance({ aiHoursMinutes: 30 }) })?.leftMinutes,
    ).toBe(30);
    // 0 = no hours (Free) → keep the dollar display.
    expect(aiHoursSummary({ subscription: null, balance: balance({ aiHoursMinutes: 0 }) })).toBe(
      null,
    );
    // An older console: no field at all.
    const old = parseSubscription({ plan: "plus-ai", ai_credits: { monthly_usd: 30 } });
    expect(old?.aiHours).toBeNull();
    expect(aiHoursSummary({ subscription: old, balance: balance() })).toBeNull();
  });
});

describe("plans with AI hours", () => {
  const catalog = parsePlanCatalog({
    plans_v2: true,
    plans: [
      { slug: "small", base_slug: "small", name: "Small", price_usd: 5, ai_hours_monthly: 5 },
      {
        slug: "small-ai",
        base_slug: "small",
        name: "Small",
        price_usd: 20,
        ai_credits_usd: 0,
        ai_hours_monthly: 40,
        ai_power: 1,
        ai_premium_usd: 0,
      },
      {
        slug: "max-ai",
        base_slug: "max",
        name: "Max",
        price_usd: 300,
        ai_credits_usd: 50,
        ai_hours_monthly: 300,
        ai_hours_unlimited: true,
        ai_full_speed_hours: 200,
        ai_power: 3,
        ai_premium_usd: 50,
      },
    ],
  });

  it("a -ai plan without premium credit still has Uno AI", () => {
    const smallAi = catalog.plans.find((plan) => plan.slug === "small-ai")!;
    expect(planHasUnoAi(smallAi)).toBe(true);
    expect(planTitle(smallAi)).toBe("Small + Uno AI");
    const rung = planLadder(catalog).find((r) => r.key === "small")!;
    expect(rung.plain?.slug).toBe("small");
    expect(rung.withAi?.slug).toBe("small-ai");
    expect(planAiHoursLine(smallAi)).toBe("40 h of AI time a month · AI power ×1");
  });

  it("describes unlimited and older plans", () => {
    const max = catalog.plans.find((plan) => plan.slug === "max-ai")!;
    expect(planAiHoursLine(max)).toBe("Unlimited AI · 200 h a month at full speed");
    const old = parsePlanCatalog({ plans: [{ slug: "pro", ai_credits_usd: 30 }] }).plans[0]!;
    expect(planAiHoursLine(old)).toBeNull();
    expect(planHasUnoAi(old)).toBe(true);
  });
});

describe("Fast unlimited, Smart in hours (plans always on)", () => {
  const fastPlan = (minutes: number) =>
    parseSubscription({
      plan: "plus-ai",
      plan_view: "always_on",
      plan_limits: {
        slug: "plus-ai",
        base_slug: "plus",
        generation: 2,
        ai_hours_monthly: 40,
        ai_fast_unlimited: true,
      },
      ai_hours: { balance_minutes: minutes, monthly_hours: 40, never_expire: true },
    });

  it("one line while Smart hours are left; AI time words", () => {
    const summary = aiHoursSummary({ subscription: fastPlan(205), balance: balance() })!;
    expect(summary.fastUnlimited).toBe(true);
    expect(summary.fastStandardSpeed).toBe(false);
    expect(aiHoursHeadline(summary)).toBe("3 h 25 min");
    expect(aiHoursCaption(summary)).toBe("Smart left · Fast is unlimited");
    expect(aiFastLine(summary)).toBe("Uno AI: Fast is unlimited. Smart uses your AI time.");
    expect(aiTimeNote(summary)).toBe(
      "Only the minutes the AI is working for you count. Ten chats in the same minute count as one minute.",
    );
  });

  it("the hours gone: Fast keeps going at standard speed", () => {
    const summary = aiHoursSummary({ subscription: fastPlan(0), balance: balance() })!;
    expect(aiFastLine(summary)).toBe(
      "Your AI time is used up. Fast keeps going at standard speed.",
    );
    // The gateway can say it before the subscription does.
    const fromStatus = aiHoursSummary({
      subscription: fastPlan(30),
      balance: balance(),
      fastStandardSpeed: true,
    })!;
    expect(fromStatus.fastStandardSpeed).toBe(true);
  });

  it("from /auth/me alone, a Fast-unlimited plan at 0 minutes still has Uno AI", () => {
    const summary = aiHoursSummary({
      balance: balance({ aiHoursMinutes: 0 }),
      fastUnlimited: true,
    });
    expect(summary && aiFastLine(summary)).toBe(
      "Your AI time is used up. Fast keeps going at standard speed.",
    );
    // Without Fast unlimited, 0 still means "no AI hours".
    expect(aiHoursSummary({ balance: balance({ aiHoursMinutes: 0 }) })).toBeNull();
  });

  it("other plans keep their words", () => {
    const summary = aiHoursSummary({ subscription: subscriptionWithHours, balance: balance() })!;
    expect(summary.fastUnlimited).toBeUndefined();
    expect(aiFastLine(summary)).toBeNull();
    expect(aiHoursCaption(summary)).toBe("AI time · never expires");
    expect(aiHoursHeadline(summary)).toBe("87 h left");
  });
});
