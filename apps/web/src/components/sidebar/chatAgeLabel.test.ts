import { describe, expect, it } from "vitest";

import { chatAgeLabel, chatAgeTitle } from "./chatAgeLabel";

// Thursday 29 Oct 2026, 15:00 local time.
const NOW = new Date(2026, 9, 29, 15, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("chatAgeLabel", () => {
  it("under a minute is now", () => {
    expect(chatAgeLabel(NOW, NOW)).toBe("now");
    expect(chatAgeLabel(NOW - 59_999, NOW)).toBe("now");
  });

  it("minutes, hours, days — whole units, rounded down", () => {
    expect(chatAgeLabel(NOW - MIN, NOW)).toBe("1m");
    expect(chatAgeLabel(NOW - 5 * MIN - 59_000, NOW)).toBe("5m");
    expect(chatAgeLabel(NOW - 59 * MIN, NOW)).toBe("59m");
    expect(chatAgeLabel(NOW - HOUR, NOW)).toBe("1h");
    expect(chatAgeLabel(NOW - 23 * HOUR - 59 * MIN, NOW)).toBe("23h");
    expect(chatAgeLabel(NOW - DAY, NOW)).toBe("1d");
    expect(chatAgeLabel(NOW - 6 * DAY - 23 * HOUR, NOW)).toBe("6d");
  });

  it("from a week on, the date: month and day this year", () => {
    expect(chatAgeLabel(NOW - 7 * DAY, NOW)).toBe("Oct 22");
    expect(chatAgeLabel(new Date(2026, 9, 12, 9).getTime(), NOW)).toBe("Oct 12");
    expect(chatAgeLabel(new Date(2026, 0, 3, 9).getTime(), NOW)).toBe("Jan 3");
  });

  it("an earlier year shows month and year", () => {
    expect(chatAgeLabel(new Date(2025, 11, 30, 9).getTime(), NOW)).toBe("Dec 2025");
  });

  it("a clock slightly ahead reads now; unknown times read nothing", () => {
    expect(chatAgeLabel(NOW + 5 * MIN, NOW)).toBe("now");
    expect(chatAgeLabel(Number.NaN, NOW)).toBe("");
    expect(chatAgeLabel(Number.NEGATIVE_INFINITY, NOW)).toBe("");
  });

  it("labels never grow younger down a newest-first list", () => {
    const ages = [0, 30_000, 4 * MIN, 3 * HOUR, 2 * DAY, 9 * DAY, 400 * DAY];
    const order = ["now", "m", "h", "d", "date", "year"];
    const kind = (label: string) =>
      label === "now"
        ? "now"
        : /^\d+m$/.test(label)
          ? "m"
          : /^\d+h$/.test(label)
            ? "h"
            : /^\d+d$/.test(label)
              ? "d"
              : /\d{4}$/.test(label)
                ? "year"
                : "date";
    const kinds = ages.map((age) => order.indexOf(kind(chatAgeLabel(NOW - age, NOW))));
    expect(kinds).toEqual([...kinds].toSorted((a, b) => a - b));
  });
});

describe("chatAgeTitle", () => {
  it("gives the exact moment for the tooltip, nothing for unknown", () => {
    expect(chatAgeTitle(NOW)).toMatch(/^Last activity /);
    expect(chatAgeTitle(Number.NaN)).toBeUndefined();
  });
});
