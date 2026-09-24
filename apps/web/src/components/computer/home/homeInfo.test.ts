import { describe, expect, it } from "vitest";

import {
  aiSpendDays,
  formatUsdShort,
  homeFolderUser,
  nameFromHandle,
  personFirstName,
} from "./homeInfo";

describe("personFirstName", () => {
  it("prefers the account's own name, first word, as written", () => {
    expect(personFirstName({ accountName: "Mikhail Torgashin", username: "bob" })).toBe("Mikhail");
    expect(personFirstName({ accountName: "mikhail" })).toBe("Mikhail");
  });

  it("falls back to a username, the computer's user, then the email — when they read as names", () => {
    expect(personFirstName({ username: "mikhail.t", osUser: "anna" })).toBe("Mikhail");
    expect(personFirstName({ username: "shubaduba4th", osUser: "mikhail" })).toBe("Mikhail");
    expect(
      personFirstName({ username: "shubaduba4th", osUser: "root", email: "anna.k@uno4.dev" }),
    ).toBe("Anna");
  });

  it("greets without a name when nothing looks like one", () => {
    expect(
      personFirstName({
        username: "shubaduba4th",
        osUser: "ubuntu",
        email: "shubaduba4th@gmail.com",
      }),
    ).toBeNull();
    expect(personFirstName({ email: "hello@getuno.xyz" })).toBeNull();
    expect(personFirstName({})).toBeNull();
  });

  it("reads handles", () => {
    expect(nameFromHandle("Mikhail_T")).toBe("Mikhail");
    expect(nameFromHandle("x")).toBeNull();
    expect(nameFromHandle("admin")).toBeNull();
    expect(nameFromHandle("михаил")).toBe("Михаил");
  });

  it("takes the user from a home folder", () => {
    expect(homeFolderUser("/Users/mikhail")).toBe("mikhail");
    expect(homeFolderUser("/home/uno/")).toBe("uno");
    expect(homeFolderUser("/")).toBeNull();
    expect(homeFolderUser(null)).toBeNull();
  });
});

// Local time: the days are cut at the person's midnight.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).toISOString();

describe("aiSpendDays", () => {
  const now = new Date(2026, 8, 24, 15, 0).getTime();

  it("gives each day the growth of the running total, today last", () => {
    const samples = [
      { at: at(22, 23, 50), totalUsd: 10 },
      { at: at(23, 12), totalUsd: 11 },
      { at: at(23, 23, 55), totalUsd: 12.5 },
      { at: at(24, 9), totalUsd: 13 },
      { at: at(24, 14, 50), totalUsd: 14.25 },
    ];
    const days = aiSpendDays(samples, now);
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toMatchObject({ today: true, usd: 1.75, since: null });
    expect(days.at(-2)).toMatchObject({ today: false, usd: 2.5, since: null });
    // The first reading's day counts from it; before it: unknown, not $0.
    expect(days.at(-3)).toMatchObject({ usd: 0, since: Date.parse(at(22, 23, 50)) });
    expect(days.slice(0, 4).map((day) => day.usd)).toEqual([null, null, null, null]);
  });

  it("counts a first day only from its first reading", () => {
    const days = aiSpendDays(
      [
        { at: at(24, 9), totalUsd: 5 },
        { at: at(24, 14), totalUsd: 5.4 },
      ],
      now,
    );
    const today = days.at(-1)!;
    expect(today.usd).toBeCloseTo(0.4);
    expect(today.since).toBe(Date.parse(at(24, 9)));
  });

  it("leaves a day this computer slept through unknown", () => {
    const days = aiSpendDays(
      [
        { at: at(20, 23, 50), totalUsd: 1 },
        { at: at(24, 10), totalUsd: 4 },
        { at: at(24, 14), totalUsd: 4.5 },
      ],
      now,
    );
    // 21–23: nothing seen; the jump from 1 to 4 isn't pinned on any of them.
    expect(days.slice(2, 6).map((day) => day.usd)).toEqual([0, null, null, null]);
    expect(days.at(-1)).toMatchObject({ usd: 0.5, since: Date.parse(at(24, 10)) });
  });

  it("knows a quiet day when the next reading shows nothing was spent", () => {
    const days = aiSpendDays(
      [
        { at: at(22, 23, 50), totalUsd: 2 },
        { at: at(23, 8), totalUsd: 2 },
        { at: at(24, 13), totalUsd: 2 },
      ],
      now,
    );
    expect(days.at(-2)!.usd).toBe(0);
    expect(days.at(-1)!.usd).toBe(0);
  });

  it("never shows a negative spend", () => {
    const days = aiSpendDays(
      [
        { at: at(23, 23, 50), totalUsd: 3 },
        { at: at(24, 12), totalUsd: 2 },
      ],
      now,
    );
    expect(days.at(-1)!.usd).toBe(0);
  });
});

describe("formatUsdShort", () => {
  it("shows cents, and a crumb as less than a cent", () => {
    expect(formatUsdShort(1.234)).toBe("$1.23");
    expect(formatUsdShort(0)).toBe("$0.00");
    expect(formatUsdShort(0.004)).toBe("<$0.01");
  });
});
