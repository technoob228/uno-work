import { describe, expect, it } from "vitest";

import { parsePlanCatalog, parseSubscription, type AccountBalance } from "./accountOverview";
import {
  aiHoursLine,
  aiHoursSummary,
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
      "AI hours: 87 h left · never expire · $12.40 premium credit",
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
    expect(planAiHoursLine(smallAi)).toBe("40 AI hours a month · AI power ×1");
  });

  it("describes unlimited and older plans", () => {
    const max = catalog.plans.find((plan) => plan.slug === "max-ai")!;
    expect(planAiHoursLine(max)).toBe("Unlimited AI · 200 h a month at full speed");
    const old = parsePlanCatalog({ plans: [{ slug: "pro", ai_credits_usd: 30 }] }).plans[0]!;
    expect(planAiHoursLine(old)).toBeNull();
    expect(planHasUnoAi(old)).toBe(true);
  });
});
