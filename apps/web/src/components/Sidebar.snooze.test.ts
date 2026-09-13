import { describe, expect, it } from "vitest";

import {
  canSnoozeThread,
  formatSnoozePickerValue,
  parseSnoozePickerValue,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "./Sidebar.snooze";

const NOW = "2026-09-13T12:00:00.000Z";

describe("resolveSnoozePresets", () => {
  it("offers 1 hour, this evening, tomorrow morning and next week on a weekday afternoon", () => {
    // Wednesday 14:00 local time.
    const now = new Date(2026, 8, 16, 14, 0, 0, 0);
    const presets = resolveSnoozePresets(now);
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(new Date(presets[0]!.snoozedUntil).getTime() - now.getTime()).toBe(60 * 60 * 1_000);
    expect(new Date(presets[1]!.snoozedUntil).getHours()).toBe(18);
    const tomorrow = new Date(presets[2]!.snoozedUntil);
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([17, 9]);
    const nextWeek = new Date(presets[3]!.snoozedUntil);
    expect([nextWeek.getDay(), nextWeek.getDate(), nextWeek.getHours()]).toEqual([1, 21, 9]);
  });

  it("drops This evening once evening is less than an hour away", () => {
    const presets = resolveSnoozePresets(new Date(2026, 8, 16, 17, 30, 0, 0));
    expect(presets.map((preset) => preset.id)).not.toContain("evening");
  });

  it("collapses Next week into Tomorrow morning on Sundays", () => {
    const presets = resolveSnoozePresets(new Date(2026, 8, 13, 20, 0, 0, 0));
    expect(presets.map((preset) => preset.id)).toEqual(["hour", "tomorrow"]);
  });
});

describe("snoozeWakeLabel", () => {
  it("rounds minutes up and switches to hours and days", () => {
    expect(snoozeWakeLabel("2026-09-13T12:00:30.000Z", NOW)).toBe("1m");
    expect(snoozeWakeLabel("2026-09-13T12:45:00.000Z", NOW)).toBe("45m");
    expect(snoozeWakeLabel("2026-09-13T15:10:00.000Z", NOW)).toBe("4h");
    expect(snoozeWakeLabel("2026-09-15T13:00:00.000Z", NOW)).toBe("3d");
  });

  it("reads now for past or malformed wake times", () => {
    expect(snoozeWakeLabel("2026-09-13T11:00:00.000Z", NOW)).toBe("now");
    expect(snoozeWakeLabel("garbage", NOW)).toBe("now");
  });
});

describe("snooze picker values", () => {
  it("round-trips local datetime-local values and rejects the past", () => {
    const now = new Date(2026, 8, 13, 12, 0, 0, 0);
    const wake = new Date(2026, 8, 14, 9, 30, 0, 0);
    const value = formatSnoozePickerValue(wake);
    expect(value).toBe("2026-09-14T09:30");
    expect(parseSnoozePickerValue(value, now)).toBe(wake.toISOString());
    expect(parseSnoozePickerValue("2026-09-13T11:59", now)).toBeNull();
    expect(parseSnoozePickerValue("tomorrow", now)).toBeNull();
  });
});

describe("canSnoozeThread", () => {
  const idle = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestUserMessageAt: "2026-09-13T10:00:00.000Z",
    latestTurn: null,
    session: null,
  };

  it("allows idle threads and refuses threads waiting on the person", () => {
    expect(canSnoozeThread(idle, NOW)).toBe(true);
    expect(canSnoozeThread({ ...idle, hasPendingApprovals: true }, NOW)).toBe(false);
    expect(canSnoozeThread({ ...idle, hasPendingUserInput: true }, NOW)).toBe(false);
  });

  it("refuses a message sent seconds ago that no turn picked up yet", () => {
    expect(canSnoozeThread({ ...idle, latestUserMessageAt: "2026-09-13T11:59:30.000Z" }, NOW)).toBe(
      false,
    );
  });
});
