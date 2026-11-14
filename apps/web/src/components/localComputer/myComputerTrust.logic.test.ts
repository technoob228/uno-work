import { describe, expect, it } from "vitest";

import {
  addToList,
  agentsActive,
  computersLabel,
  formatDuration,
  GRANT_HOURS,
  grantUntilLabel,
  IDLE_HOURS,
  journalMeta,
  journalResult,
  parseHours,
  pauseLine,
  sameTrustSettings,
  stopAllToast,
} from "./myComputerTrust.logic";

const clock = () => "16:00";

describe("formatDuration", () => {
  it("reads like a person would say it", () => {
    expect(formatDuration(120)).toBe("120 ms");
    expect(formatDuration(1_234)).toBe("1.2 s");
    expect(formatDuration(14_900)).toBe("14 s");
    expect(formatDuration(3 * 60_000 + 5_000)).toBe("3 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });
});

describe("journalResult", () => {
  it("shows the exit code and how long it took", () => {
    expect(journalResult({ tier: "free", outcome: "ran", exitCode: 0, durationMs: 1_200 })).toBe(
      "exit 0 · 1.2 s",
    );
    expect(journalResult({ tier: "chat", outcome: "failed", exitCode: 2, durationMs: 300 })).toBe(
      "exit 2 · 300 ms",
    );
  });

  it("says why a call was refused", () => {
    expect(
      journalResult({
        tier: "blocked",
        outcome: "refused",
        reason: "Containers run in the cloud, not on the person’s computer",
      }),
    ).toBe("refused: Containers run in the cloud, not on the person’s computer");
    expect(journalResult({ tier: "blocked", outcome: "refused" })).toBe("refused");
  });

  it("tells stopped and killed calls apart", () => {
    expect(journalResult({ outcome: "stopped", exitCode: null, durationMs: 3_000 })).toBe(
      "stopped · 3 s",
    );
    expect(journalResult({ outcome: "failed", exitCode: null })).toBe("killed");
    expect(journalResult({ outcome: "failed" })).toBe("failed");
  });

  it("keeps a read short and an old line silent", () => {
    expect(journalResult({ tier: "free", outcome: "ran", durationMs: 40 })).toBe("40 ms");
    expect(journalResult({})).toBeNull();
    expect(journalResult({ tier: "chat" })).toBe("running");
  });

  it("puts the chat first", () => {
    expect(journalMeta({ threadTitle: "Fix the landing build", outcome: "ran", exitCode: 0 })).toBe(
      "Fix the landing build · exit 0",
    );
    expect(journalMeta({ threadTitle: "  " })).toBeNull();
    expect(journalMeta({ threadTitle: "Landing", outcome: "ran", exitCode: 0 }, false)).toBe(
      "exit 0",
    );
  });
});

describe("the pause and the banner", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("explains the pause", () => {
    expect(pauseLine({ reason: "idle" }, 12)).toBe("No agent activity for 12 h.");
    expect(pauseLine({ reason: "stopped" }, 12)).toBe("You stopped them.");
  });

  it("shows while something runs or ran in the last 10 minutes", () => {
    expect(agentsActive({ running: 1, lastActivityAt: null, paused: null }, now)).toBe(true);
    expect(agentsActive({ running: 0, lastActivityAt: ago(4), paused: null }, now)).toBe(true);
    expect(agentsActive({ running: 0, lastActivityAt: ago(11), paused: null }, now)).toBe(false);
    expect(agentsActive({ running: 0, lastActivityAt: null, paused: null }, now)).toBe(false);
  });

  it("stays away while agents are paused", () => {
    expect(
      agentsActive(
        { running: 0, lastActivityAt: ago(1), paused: { at: ago(1), reason: "stopped" } },
        now,
      ),
    ).toBe(false);
  });

  it("names one computer, else says yours", () => {
    expect(computersLabel([{ name: "MacBook" }])).toBe("MacBook");
    expect(computersLabel([])).toBe("your computer");
    expect(computersLabel([{ name: "A" }, { name: "B" }])).toBe("your computers");
  });
});

describe("stopAllToast", () => {
  it("counts what stopped and who was disconnected", () => {
    expect(stopAllToast({ stopped: 2, disconnected: ["MacBook"], failed: [] })).toEqual({
      type: "success",
      title: "Agents stopped",
      description: "Stopped 2 calls. Disconnected MacBook.",
    });
    expect(stopAllToast({ stopped: 0, disconnected: [], failed: [] }).description).toBe(
      "Nothing was running.",
    );
  });

  it("warns about a computer that stayed connected", () => {
    const toast = stopAllToast({ stopped: 1, disconnected: [], failed: ["iMac"] });
    expect(toast.type).toBe("warning");
    expect(toast.description).toBe(
      "Stopped 1 call. Couldn’t disconnect iMac. Agents stay paused there until you resume.",
    );
  });
});

describe("the settings form", () => {
  it("adds trimmed entries once", () => {
    expect(addToList(["~/projects"], "  ~/work ")).toEqual(["~/projects", "~/work"]);
    expect(addToList(["~/projects"], "~/projects")).toBeNull();
    expect(addToList([], "   ")).toBeNull();
  });

  it("keeps hours within bounds", () => {
    expect(parseHours("4", GRANT_HOURS)).toBe(4);
    expect(parseHours("40", GRANT_HOURS)).toBe(24);
    expect(parseHours("0", IDLE_HOURS)).toBe(1);
    expect(parseHours("abc", IDLE_HOURS)).toBeNull();
  });

  it("compares whole settings", () => {
    const base = {
      allowedFolders: ["~/projects"],
      allowedCommands: ["make"],
      grantHours: 4,
      idleHours: 12,
    };
    expect(sameTrustSettings(base, { ...base })).toBe(true);
    expect(sameTrustSettings(base, { ...base, allowedCommands: ["make", "bun run dev"] })).toBe(
      false,
    );
  });

  it("says until when a chat's Allow lasts", () => {
    const now = new Date(2026, 10, 13, 12, 0).getTime();
    expect(grantUntilLabel(new Date(2026, 10, 13, 16, 0).toISOString(), now, clock)).toBe(
      "until 16:00",
    );
    expect(grantUntilLabel(new Date(2026, 10, 14, 9, 0).toISOString(), now, clock)).toBe(
      "until Nov 14, 16:00",
    );
  });
});
