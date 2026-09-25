import { describe, expect, it } from "vitest";

import {
  type AccessEntry,
  type AccessSummary,
  accessLogPath,
  accessStatus,
  automaticLabel,
  burstLabel,
  channelLabel,
  collapseBursts,
  entryText,
  dayLabel,
  failedAttemptsLine,
  groupByDay,
  isMaintenance,
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
    expect(v.title).toBe("No unexplained logins with Uno's key in the last 30 days.");
    expect(v.description).toContain(
      "Every time Uno's key signed in to this computer, it matches an operation",
    );
    expect(v.description).not.toMatch(/cannot access/i);
  });

  it("is red for Uno's key without a record and promises an answer in 24 hours", () => {
    expect(verdictFor(summary({ uno_unexplained: 1 })).title).toBe(
      "Uno used its key 1 time without a record",
    );
    const v = verdictFor(summary({ uno_unexplained: 3, uno_maintenance: 46 }));
    expect(v.tone).toBe("bad");
    expect(v.title).toBe("Uno used its key 3 times without a record");
    expect(v.description).toContain("within 24 hours");
  });

  it("is amber for maintenance and states Uno's access policy", () => {
    const v = verdictFor(summary({ uno_maintenance: 46 }));
    expect(v.tone).toBe("notice");
    expect(v.title).toBe("Uno did maintenance on this computer (46 entries)");
    expect(v.description).toContain("without asking first, and always tells you right away");
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
    expect(overviewBadge(base)).toEqual({
      tone: "good",
      text: "No unexplained Uno logins (30 days)",
    });
    expect(overviewBadge({ ...base, uno_unexplained_30d: 2 })).toEqual({
      tone: "bad",
      text: "Uno without a record: 2 — we'll explain",
    });
    expect(overviewBadge({ ...base, uno_maintenance_30d: 47 })).toEqual({
      tone: "notice",
      text: "Uno maintenance — see why",
    });
  });
});

describe("Uno's access in plain words", () => {
  const old = (o: Partial<AccessEntry> = {}) =>
    entry({
      actor: "uno_staff",
      channel: "ssh",
      explained: false,
      who: "Uno's key — no matching record",
      detail: "A command ran through Uno's node channel without a matching Uno record",
      ...o,
    });

  it("before: a bare row from an older console is red, with the new wording", () => {
    const e = old();
    expect(accessStatus(e)).toBe("unaccounted");
    expect(isUnexplained(e)).toBe(true);
    expect(entryText(e)).toEqual({
      title: "Uno used its key without a record",
      note: "We'll explain this here within 24 hours.",
    });
  });

  it("a stated reason turns the row amber, not red", () => {
    const e = old({
      status: "maintenance_stated",
      reason: "fix container networking (Uno agent update)",
    });
    expect(isUnexplained(e)).toBe(false);
    expect(isMaintenance(e)).toBe(true);
    expect(entryText(e).title).toBe("Uno maintenance: fix container networking (Uno agent update)");
    expect(entryText(e).note).toContain("Reason given by Uno's maintenance tool");
  });

  it("after: an appended explanation wins, the row itself stays as it was", () => {
    const e = old({
      status: "maintenance",
      explanation: { id: 9001, at: local(24, 23), reason: "fixed container networking on Sep 24" },
    });
    expect(accessStatus(e)).toBe("maintenance");
    expect(entryText(e)).toEqual({
      title: "Uno maintenance: fixed container networking on Sep 24",
      note: "Uno added this explanation later. The entry itself is unchanged.",
    });
    // Without the status field (older console) the explanation still counts.
    const { status: _status, ...withoutStatus } = e;
    expect(accessStatus(withoutStatus)).toBe("maintenance");
  });

  it("the explanation row says how many entries it explains", () => {
    const e = entry({
      actor: "uno_staff",
      channel: "maintenance",
      explained: true,
      status: "maintenance",
      reason: "fixed container networking on Sep 24",
      explains: [1, 2, 3],
    });
    expect(channelLabel(e)).toBe("Uno maintenance");
    expect(entryText(e).note).toBe("Explains 3 earlier entries that had no record.");
  });

  it("a signed maintenance run shows its reference", () => {
    const e = entry({
      actor: "uno_staff",
      channel: "maintenance",
      explained: true,
      status: "maintenance",
      reason: "fix container networking",
      ref: "MW-20260924-guest-net",
    });
    expect(entryText(e)).toEqual({
      title: "Uno maintenance: fix container networking",
      note: "Reference MW-20260924-guest-net",
    });
  });

  it("collapses a 46-command run into one line", () => {
    const run = Array.from({ length: 46 }, (_, i) =>
      old({
        at: new Date(2026, 8, 24, 22, 17, 16 - i).toISOString(),
        status: "maintenance",
        explanation: {
          id: 9001,
          at: local(24, 23),
          reason: "fixed container networking on Sep 24",
        },
      }),
    );
    const you = entry({ at: new Date(2026, 8, 24, 22, 30).toISOString() });
    const items = collapseBursts([you, ...run]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "entry", entry: you });
    const burst = items[1]!;
    if (burst.kind !== "burst") throw new Error("expected a burst");
    expect(burst.entries).toHaveLength(46);
    expect(burstLabel(burst)).toBe("46 commands · 22:16–22:17");
  });

  it("keeps short runs and different reasons apart", () => {
    const a = old({ reason: "a reason here", status: "maintenance_stated" });
    const b = old({ reason: "another reason", status: "maintenance_stated" });
    expect(collapseBursts([a, b, a]).every((i) => i.kind === "entry")).toBe(true);
    const far = [0, 20, 40].map((m) => old({ at: new Date(2026, 8, 24, 22, m).toISOString() }));
    expect(collapseBursts(far).every((i) => i.kind === "entry")).toBe(true);
  });
});
