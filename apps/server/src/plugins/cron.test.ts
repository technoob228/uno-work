import { describe, expect, it } from "vitest";

import { cronMatches, cronMinuteKey, parseCronExpression, parseEveryDuration } from "./cron.ts";
import { hookMatches } from "./PluginRuntime.ts";

const at = (year: number, month: number, day: number, hours: number, minutes: number): Date =>
  new Date(year, month - 1, day, hours, minutes);

describe("parseCronExpression", () => {
  it("parses wildcards", () => {
    const spec = parseCronExpression("* * * * *");
    expect(spec).toBeDefined();
    expect(spec!.minutes.size).toBe(60);
    expect(spec!.hours.size).toBe(24);
    expect(spec!.dayOfMonthRestricted).toBe(false);
    expect(spec!.dayOfWeekRestricted).toBe(false);
  });

  it("parses steps, ranges, and lists", () => {
    const spec = parseCronExpression("*/15 9-17 1,15 * 1-5");
    expect(spec).toBeDefined();
    expect([...spec!.minutes].toSorted((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(spec!.hours.has(9)).toBe(true);
    expect(spec!.hours.has(17)).toBe(true);
    expect(spec!.hours.has(18)).toBe(false);
    expect(spec!.daysOfMonth.has(15)).toBe(true);
    expect(spec!.daysOfWeek.has(3)).toBe(true);
    expect(spec!.daysOfWeek.has(6)).toBe(false);
  });

  it("treats day-of-week 7 as Sunday", () => {
    const spec = parseCronExpression("0 0 * * 7");
    expect(spec).toBeDefined();
    expect(spec!.daysOfWeek.has(0)).toBe(true);
  });

  it("rejects malformed expressions", () => {
    for (const expression of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "a * * * *",
      "* * 0 * *",
    ]) {
      expect(parseCronExpression(expression), expression).toBeUndefined();
    }
  });
});

describe("cronMatches", () => {
  it("matches minute and hour", () => {
    const spec = parseCronExpression("30 9 * * *")!;
    expect(cronMatches(spec, at(2026, 8, 24, 9, 30))).toBe(true);
    expect(cronMatches(spec, at(2026, 8, 24, 9, 31))).toBe(false);
    expect(cronMatches(spec, at(2026, 8, 24, 10, 30))).toBe(false);
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // 2026-08-24 is a Monday, day-of-month 24.
    const spec = parseCronExpression("0 0 1 * 1")!;
    expect(cronMatches(spec, at(2026, 8, 24, 0, 0))).toBe(true); // Monday, not the 1st
    expect(cronMatches(spec, at(2026, 9, 1, 0, 0))).toBe(true); // the 1st (a Tuesday)
    expect(cronMatches(spec, at(2026, 8, 25, 0, 0))).toBe(false); // Tuesday the 25th
  });

  it("ANDs day fields when only one is restricted", () => {
    const spec = parseCronExpression("0 0 * * 1")!;
    expect(cronMatches(spec, at(2026, 8, 24, 0, 0))).toBe(true);
    expect(cronMatches(spec, at(2026, 8, 25, 0, 0))).toBe(false);
  });
});

describe("parseEveryDuration", () => {
  it("parses supported units", () => {
    expect(parseEveryDuration("5m")).toBe(5 * 60_000);
    expect(parseEveryDuration("2h")).toBe(2 * 3_600_000);
    expect(parseEveryDuration("1d")).toBe(86_400_000);
  });

  it("clamps to the one-minute floor", () => {
    expect(parseEveryDuration("10s")).toBe(60_000);
  });

  it("rejects malformed durations", () => {
    for (const every of ["", "5", "m", "5w", "-5m", "1.5h"]) {
      expect(parseEveryDuration(every), every).toBeUndefined();
    }
  });
});

describe("cronMinuteKey", () => {
  it("changes across minutes and is stable within one", () => {
    expect(cronMinuteKey(at(2026, 8, 24, 9, 30))).toBe(cronMinuteKey(at(2026, 8, 24, 9, 30)));
    expect(cronMinuteKey(at(2026, 8, 24, 9, 30))).not.toBe(cronMinuteKey(at(2026, 8, 24, 9, 31)));
  });
});

describe("hookMatches", () => {
  it("matches exact, wildcard, and prefix patterns", () => {
    expect(hookMatches("thread.created", "thread.created")).toBe(true);
    expect(hookMatches("thread.created", "thread.deleted")).toBe(false);
    expect(hookMatches("*", "project.created")).toBe(true);
    expect(hookMatches("thread.*", "thread.turn-diff-completed")).toBe(true);
    expect(hookMatches("thread.*", "project.created")).toBe(false);
    expect(hookMatches("thread*", "thread.created")).toBe(false);
  });
});
