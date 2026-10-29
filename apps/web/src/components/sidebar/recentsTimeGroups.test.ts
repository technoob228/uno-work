import { describe, expect, it } from "vitest";

import {
  flattenRecentsTimeGroups,
  groupRecentsByTime,
  recentsTimeGroupOf,
} from "./recentsTimeGroups";

// Thursday 29 Oct 2026, 15:00 local time.
const NOW = new Date(2026, 9, 29, 15, 0);
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();

describe("recentsTimeGroupOf", () => {
  it("splits by calendar day in local time", () => {
    expect(recentsTimeGroupOf(at(29, 0), NOW)).toBe("today");
    expect(recentsTimeGroupOf(at(28, 23), NOW)).toBe("yesterday");
    expect(recentsTimeGroupOf(at(28, 0), NOW)).toBe("yesterday");
  });

  it("this week starts on Monday", () => {
    expect(recentsTimeGroupOf(at(26, 9), NOW)).toBe("week"); // Monday
    expect(recentsTimeGroupOf(at(25, 23), NOW)).toBe("older"); // Sunday
  });

  it("on a Monday the week is just today and yesterday is Sunday", () => {
    const monday = new Date(2026, 10, 2, 10, 0);
    expect(recentsTimeGroupOf(new Date(2026, 10, 1, 18).getTime(), monday)).toBe("yesterday");
    expect(recentsTimeGroupOf(new Date(2026, 9, 31, 18).getTime(), monday)).toBe("older");
  });

  it("crosses a month boundary", () => {
    const first = new Date(2026, 10, 1, 9, 0); // Sunday 1 Nov
    expect(recentsTimeGroupOf(new Date(2026, 9, 31, 22).getTime(), first)).toBe("yesterday");
    expect(recentsTimeGroupOf(new Date(2026, 9, 26, 8).getTime(), first)).toBe("week");
  });

  it("puts unknown times under Older and future ones under Today", () => {
    expect(recentsTimeGroupOf(Number.NaN, NOW)).toBe("older");
    expect(recentsTimeGroupOf(Number.NEGATIVE_INFINITY, NOW)).toBe("older");
    expect(recentsTimeGroupOf(at(30), NOW)).toBe("today");
  });
});

describe("groupRecentsByTime", () => {
  it("labels the runs of a newest-first list and skips empty groups", () => {
    const chats = [
      { id: "a", t: at(29, 14) },
      { id: "b", t: at(29, 1) },
      { id: "c", t: at(27) },
      { id: "d", t: at(10) },
    ];
    const groups = groupRecentsByTime({ chats, timeOf: (chat) => chat.t, now: NOW });
    expect(groups.map((group) => [group.label, group.chats.map((chat) => chat.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["This week", ["c"]],
      ["Older", ["d"]],
    ]);
    expect(flattenRecentsTimeGroups(groups)).toEqual(chats);
  });

  it("keeps a stray chat in its own group, in order", () => {
    const chats = [
      { id: "a", t: at(29) },
      { id: "b", t: at(1) },
      { id: "c", t: at(29, 2) },
    ];
    const groups = groupRecentsByTime({ chats, timeOf: (chat) => chat.t, now: NOW });
    expect(groups.map((group) => group.chats.map((chat) => chat.id))).toEqual([["a", "c"], ["b"]]);
  });

  it("returns nothing for no chats", () => {
    expect(groupRecentsByTime({ chats: [], timeOf: () => 0, now: NOW })).toEqual([]);
  });
});
