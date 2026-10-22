import type { EnvironmentId, ProjectId, ProjectSyncEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  conflictLine,
  entriesByProject,
  refreshEveryMs,
  syncLabel,
  syncMarkOf,
  toggleMenuLabel,
} from "./projectSync.logic";
import { mostUrgent } from "./ProjectSyncParts";

const entry = (patch: Partial<ProjectSyncEntry>): ProjectSyncEntry => ({
  projectId: "p1" as ProjectId,
  enabled: true,
  name: "notes",
  mode: "snapshot",
  state: "synced",
  message: "",
  lastSyncedAt: null,
  conflict: null,
  ...patch,
});

describe("project sync marks", () => {
  it("✓ synced, ↻ syncing, ⚠ conflict, a problem; nothing when off or empty", () => {
    expect(syncMarkOf("synced")).toBe("synced");
    expect(syncMarkOf("syncing")).toBe("syncing");
    expect(syncMarkOf("conflict")).toBe("conflict");
    for (const state of ["too-big", "blocked", "error"] as const)
      expect(syncMarkOf(state)).toBe("problem");
    expect(syncMarkOf("off")).toBeNull();
    expect(syncMarkOf("empty")).toBeNull();
    expect(syncMarkOf(undefined)).toBeNull();
  });

  it("a project on several computers shows its most urgent mark", () => {
    const synced = entry({ state: "synced" });
    const conflict = entry({ state: "conflict" });
    expect(mostUrgent([synced, conflict, entry({ state: "syncing" })])).toBe(conflict);
    expect(mostUrgent([entry({ state: "off", enabled: false })])).toBeNull();
  });

  it("says in plain words what happened in a conflict", () => {
    const line = conflictLine(
      entry({
        state: "conflict",
        conflict: { files: ["plan.md"], kept: { "plan.md": "theirs" }, from: "uno-work", at: "" },
      }),
    );
    expect(line).toBe(
      "plan.md changed here and on uno-work. The version from uno-work is kept; the other one is in the history.",
    );
    expect(
      conflictLine(
        entry({
          state: "conflict",
          conflict: { files: ["a", "b"], kept: { a: "mine", b: "theirs" }, from: null, at: "" },
        }),
      ),
    ).toBe(
      "2 files changed on two computers. The newer version of each is kept; the other one is in the history.",
    );
  });

  it("labels, menu and refresh pace", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(syncLabel(entry({ lastSyncedAt: "2026-10-22T11:55:00Z" }), now)).toBe(
      "On all your computers · synced 5 min ago.",
    );
    expect(syncLabel(entry({ state: "too-big", message: "video.mp4 is 2 GB" }))).toBe(
      "video.mp4 is 2 GB",
    );
    expect(toggleMenuLabel(true)).toBe("✓ On all my computers");
    expect(toggleMenuLabel(false)).toBe("On all my computers");
    const snapshot = {
      available: true,
      unavailableReason: null,
      elsewhere: [],
      projects: [entry({ state: "syncing" })],
    };
    expect(refreshEveryMs(snapshot)).toBe(2_000);
    expect(refreshEveryMs(undefined)).toBe(30_000);
    const map = entriesByProject([{ environmentId: "env-a" as EnvironmentId, status: snapshot }]);
    expect(map.get("env-a:p1")?.state).toBe("syncing");
  });
});
