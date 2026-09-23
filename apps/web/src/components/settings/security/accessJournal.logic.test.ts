import { describe, expect, it } from "vitest";

import {
  type AccessEntry,
  type AccessSummary,
  accessLogPath,
  automaticLabel,
  channelLabel,
  dayLabel,
  failedAttemptsLine,
  groupByDay,
  isUnexplained,
  lastAccessLine,
  matchesFilter,
  overviewBadge,
  relativeTime,
  scanNote,
  verdictFor,
} from "./accessJournal.logic";

const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const NOW = new Date(2026, 8, 23, 15, 0).getTime();

let nextId = 1;
function entry(overrides: Partial<AccessEntry>): AccessEntry {
  return {
    id: nextId++,
    box_id: 5,
    at: local(23, 12),
    channel: "work",
    actor: "owner",
    who: "You",
    ...overrides,
  };
}

const summary = (overrides: Partial<AccessSummary> = {}): AccessSummary => ({
  total: 0,
  you: 0,
  agents: 0,
  uno_auto: 0,
  uno_unexplained: 0,
  ssh_others: 0,
  failed_ssh_attempts: 0,
  failed_ssh_sources: 0,
  ...overrides,
});

describe("filters", () => {
  const you = entry({ actor: "owner" });
  const agent = entry({ actor: "agent", channel: "command" });
  const auto = entry({ actor: "uno_auto", channel: "system" });
  const staff = entry({ actor: "uno_staff", channel: "ssh", explained: false });
  const other = entry({ actor: "other", channel: "ssh" });
  const all = [you, agent, auto, staff, other];

  it("splits by who got in", () => {
    expect(all.filter((e) => matchesFilter(e, "all"))).toHaveLength(5);
    expect(all.filter((e) => matchesFilter(e, "you"))).toEqual([you]);
    expect(all.filter((e) => matchesFilter(e, "agents"))).toEqual([agent]);
    expect(all.filter((e) => matchesFilter(e, "uno"))).toEqual([auto, staff]);
    expect(all.filter((e) => matchesFilter(e, "ssh"))).toEqual([staff, other]);
  });

  it("flags only Uno-key logins without a record", () => {
    expect(isUnexplained(staff)).toBe(true);
    expect(isUnexplained(entry({ actor: "uno_staff", explained: true }))).toBe(false);
    expect(isUnexplained(auto)).toBe(false);
  });
});

describe("labels", () => {
  it("names the way in", () => {
    expect(channelLabel({ channel: "work", client: "Uno Work in the browser" })).toBe(
      "Uno Work in the browser",
    );
    expect(channelLabel({ channel: "work", client: "Uno Work app" })).toBe("Uno Work app");
    expect(channelLabel({ channel: "cron" })).toBe("Scheduled task");
    expect(channelLabel({ channel: "app" })).toBe("App install");
    expect(channelLabel({ channel: "system" })).toBe("Uno automation");
  });

  it("formats relative time and days", () => {
    expect(relativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime(new Date(NOW - 60_000).toISOString(), NOW)).toBe("1 minute ago");
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 hours ago");
    expect(dayLabel(local(23, 1), NOW)).toBe("Today");
    expect(dayLabel(local(22, 23), NOW)).toBe("Yesterday");
    expect(dayLabel(local(21, 10), NOW)).toBe("Mon, Sep 21");
  });

  it("builds the API path", () => {
    expect(accessLogPath(7)).toBe("/api/v1/boxes/7/security/access-log?days=30");
  });
});

describe("groupByDay", () => {
  it("groups newest-first entries by local day and folds automation away", () => {
    const rows = [
      entry({ at: local(23, 14), actor: "owner" }),
      entry({ at: local(23, 13), actor: "uno_auto", channel: "system" }),
      entry({ at: local(23, 12), actor: "uno_staff", channel: "ssh", explained: false }),
      entry({ at: local(22, 9), actor: "uno_auto", channel: "system" }),
      entry({ at: "not a date" }),
    ];
    const days = groupByDay(rows, NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0]!.visible).toHaveLength(2);
    expect(days[0]!.automatic).toHaveLength(1);
    expect(days[1]!.visible).toHaveLength(0);
    expect(days[1]!.automatic).toHaveLength(1);
    expect(automaticLabel(1)).toBe("1 automatic operation by Uno");
    expect(automaticLabel(4)).toBe("4 automatic operations by Uno");
  });
});

describe("verdict and notes", () => {
  it("is green when every Uno-key login is matched", () => {
    const v = verdictFor(summary());
    expect(v.tone).toBe("good");
    expect(v.title).toBe("Nobody from Uno logged in by hand in the last 30 days.");
    expect(v.description).toContain("Every login with Uno's key matches an automatic operation");
    expect(v.description).not.toMatch(/cannot access/i);
  });

  it("is red and counts unmatched logins", () => {
    expect(verdictFor(summary({ uno_unexplained: 1 })).title).toBe(
      "1 login with Uno's key has no matching record",
    );
    const v = verdictFor(summary({ uno_unexplained: 3 }));
    expect(v.tone).toBe("bad");
    expect(v.title).toBe("3 logins with Uno's key have no matching record");
    expect(v.description).toContain("Contact support");
  });

  it("explains failed attempts and scan status", () => {
    expect(failedAttemptsLine(summary())).toBeNull();
    expect(failedAttemptsLine(summary({ failed_ssh_attempts: 46, failed_ssh_sources: 3 }))).toBe(
      "46 failed SSH attempts from 3 addresses (bots scanning the internet — they didn't get in)",
    );
    expect(scanNote("asleep")).toBe(
      "The computer is asleep — SSH logins will be read from it when it wakes up.",
    );
    expect(scanNote("ok")).toBeNull();
    expect(scanNote("throttled")).toBeNull();
  });

  it("summarizes a computer for the overview", () => {
    const base = {
      box_id: 1,
      name: "Main",
      status: "running",
      entries_30d: 4,
      uno_unexplained_30d: 0,
      last_access: { at: new Date(NOW - 5 * 60_000).toISOString(), who: "You", channel: "work" },
    };
    expect(lastAccessLine(base, NOW)).toBe("Last access: 5 minutes ago — You");
    expect(lastAccessLine({ ...base, last_access: null }, NOW)).toBe("No access recorded yet");
    expect(overviewBadge(base)).toEqual({ tone: "good", text: "No Uno staff access (30 days)" });
    expect(overviewBadge({ ...base, uno_unexplained_30d: 2 })).toEqual({
      tone: "bad",
      text: "2 Uno logins without a record",
    });
  });
});
