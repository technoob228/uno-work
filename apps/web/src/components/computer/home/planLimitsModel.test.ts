import type { PlanLimitsAccount, PlanLimitsWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  planAccountTitle,
  planHasNoLimits,
  planProblemText,
  planResetText,
  planStaleText,
  planUsageTone,
  planUsedPercent,
  planWindowTitle,
} from "./planLimitsModel";

const NOW = Date.parse("2026-10-28T18:00:00Z");

const window = (over: Partial<PlanLimitsWindow> = {}): PlanLimitsWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 50,
  windowDurationMins: 300,
  ...over,
});

const account = (over: Partial<PlanLimitsAccount> = {}): PlanLimitsAccount => ({
  id: "claude:misha@example.com",
  provider: "claude",
  windows: [window()],
  ...over,
});

describe("planAccountTitle", () => {
  it("names the provider and the plan", () => {
    expect(planAccountTitle(account({ plan: "Max 20x" }))).toBe("Claude Max 20x");
    expect(planAccountTitle(account({ provider: "chatgpt", plan: "Plus" }))).toBe("ChatGPT Plus");
    expect(planAccountTitle(account())).toBe("Claude");
  });
});

describe("planWindowTitle", () => {
  it("says what each limit is in plain words", () => {
    expect(planWindowTitle(window())).toBe("5-hour limit");
    expect(planWindowTitle(window({ id: "seven_day", kind: "weekly" }))).toBe("Weekly limit");
    expect(planWindowTitle(window({ id: "primary", kind: "monthly" }))).toBe("Monthly limit");
    expect(planWindowTitle(window({ id: "seven_day_fable", kind: "weekly", scope: "Fable" }))).toBe(
      "Weekly · Fable",
    );
    expect(planWindowTitle(window({ id: "monthly_spend", kind: "monthly" }))).toBe(
      "Extra usage this month",
    );
    expect(planWindowTitle(window({ windowDurationMins: undefined }))).toBe("Short limit");
    expect(planWindowTitle(window({ id: "x", kind: "other", label: "Daily All" }))).toBe(
      "Daily All",
    );
  });
});

describe("planUsedPercent and planUsageTone", () => {
  it("rounds without claiming a full limit too early", () => {
    expect(planUsedPercent(window({ usedPercent: 52.76 }))).toBe(53);
    expect(planUsedPercent(window({ usedPercent: 99.6 }))).toBe(99);
    expect(planUsedPercent(window({ usedPercent: 100 }))).toBe(100);
  });

  it("warns from 70% and calls it full from 90%", () => {
    expect(planUsageTone(window({ usedPercent: 69.9 }))).toBe("ok");
    expect(planUsageTone(window({ usedPercent: 70 }))).toBe("high");
    expect(planUsageTone(window({ usedPercent: 90 }))).toBe("full");
  });
});

describe("planResetText", () => {
  const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
  const utc = { locale: "en-US", timeZone: "UTC" };

  it("counts down within a day, then names the day", () => {
    expect(planResetText(at(45), NOW)).toBe("Resets in 45 min");
    expect(planResetText(at(0.5), NOW)).toBe("Resets in 1 min");
    expect(planResetText(at(200), NOW)).toBe("Resets in 3 h 20 min");
    expect(planResetText(at(180), NOW)).toBe("Resets in 3 h");
    expect(planResetText("2026-10-30T18:00:00Z", NOW, utc)).toBe("Resets Fri 6:00 PM");
    expect(planResetText("2026-11-05T07:59:00Z", NOW, utc)).toBe("Resets Nov 5, 7:59 AM");
  });

  it("says an old window already reset, and nothing without a time", () => {
    expect(planResetText(at(-5), NOW)).toBe("Reset since");
    expect(planResetText(undefined, NOW)).toBeNull();
    expect(planResetText("soon", NOW)).toBeNull();
  });
});

describe("planStaleText and planProblemText", () => {
  const checkedAt = new Date(NOW - 3 * 3_600_000).toISOString();

  it("dates numbers that aren't from the latest read", () => {
    expect(planStaleText(account({ stale: true, checkedAt }), NOW)).toBe("Numbers from 3 h ago");
    expect(
      planStaleText(
        account({ stale: true, checkedAt: new Date(NOW - 30 * 3_600_000).toISOString() }),
        NOW,
      ),
    ).toBe("Numbers from yesterday");
    expect(planStaleText(account({ checkedAt }), NOW)).toBeNull();
  });

  it("says what to do, with and without old numbers", () => {
    expect(planProblemText(account())).toBeNull();
    expect(planProblemText(account({ problem: "expired" }))).toBe(
      "They update the next time you chat with Claude here.",
    );
    expect(planProblemText(account({ provider: "chatgpt", windows: [], problem: "expired" }))).toBe(
      "Limits show after your next chat with Codex here.",
    );
    expect(planProblemText(account({ windows: [], problem: "unreachable" }))).toBe(
      "Couldn't read limits just now.",
    );
    expect(planProblemText(account({ problem: "unexpected" }))).toBe(
      "Couldn't read new ones just now.",
    );
    expect(planProblemText(account({ problem: "rejected" }))).toMatch(/Settings → Agents/);
    expect(planProblemText(account({ problem: "locked" }))).toMatch(/Restart Uno Work/);
  });

  it("knows a plan without any limit", () => {
    expect(planHasNoLimits(account({ windows: [] }))).toBe(true);
    expect(planHasNoLimits(account({ windows: [], problem: "busy" }))).toBe(false);
    expect(planHasNoLimits(account())).toBe(false);
  });
});
