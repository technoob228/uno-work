import type {
  EnvironmentId,
  ProjectId,
  ProjectSyncEntry,
  ProjectVersion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  SHARED_PROJECT_HERE,
  arrivalWords,
  arrivalsToBring,
  conflictLine,
  entriesByProject,
  fileCount,
  groupVersions,
  hostLine,
  mineWasReplaced,
  nameList,
  projectKeyCount,
  refreshEveryMs,
  sharedWaitingLine,
  syncLabel,
  syncMarkOf,
  toggleMenuLabel,
  versionDay,
  versionLine,
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

const version = (patch: Partial<ProjectVersion>): ProjectVersion => ({
  id: "a".repeat(40),
  at: "2026-10-30T12:00:00.000Z",
  person: "Misha",
  computer: "macbook",
  note: null,
  files: [{ path: "plan.md", change: "changed" }],
  moreFiles: 0,
  ...patch,
});

describe("versions", () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime();

  it("says today, yesterday, then the date", () => {
    expect(versionDay(new Date(2026, 9, 30, 0, 5).toISOString(), now)).toBe("Today");
    expect(versionDay(new Date(2026, 9, 29, 23, 55).toISOString(), now)).toBe("Yesterday");
    expect(versionDay(new Date(2026, 9, 26, 9, 0).toISOString(), now)).toContain("26 Oct");
    expect(versionDay(new Date(2025, 9, 26, 9, 0).toISOString(), now)).toContain("2025");
  });

  it("groups by day, keeping the order", () => {
    const groups = groupVersions(
      [
        version({ id: "1", at: new Date(2026, 9, 30, 14, 0).toISOString() }),
        version({ id: "2", at: new Date(2026, 9, 30, 9, 0).toISOString() }),
        version({ id: "3", at: new Date(2026, 9, 29, 20, 0).toISOString() }),
      ],
      now,
    );
    expect(groups.map((group) => [group.day, group.versions.map((item) => item.id)])).toEqual([
      ["Today", ["1", "2"]],
      ["Yesterday", ["3"]],
    ]);
  });

  it("reads like a person wrote it, with no git words", () => {
    expect(versionLine(version({}))).toBe("Misha on macbook · plan.md");
    expect(versionLine(version({ mine: true }))).toBe("You on macbook · plan.md");
    expect(versionLine(version({ mine: true, computer: null }))).toBe("You · plan.md");
    expect(versionLine(version({ person: null }))).toBe("macbook · plan.md");
    expect(versionLine(version({ person: null, computer: null }))).toBe("Saved · plan.md");
    expect(
      versionLine(
        version({
          files: [
            { path: "a", change: "added" },
            { path: "b", change: "removed" },
          ],
          moreFiles: 3,
        }),
      ),
    ).toBe("Misha on macbook · 5 files");
    expect(versionLine(version({ note: "Went back to 29 Oct, 14:20", files: [] }))).toBe(
      "Went back to 29 Oct, 14:20",
    );
  });
});

describe("words", () => {
  it("counts files and lists names", () => {
    expect(fileCount(1)).toBe("1 file");
    expect(fileCount(1280)).toBe("1,280 files");
    expect(nameList(["a"])).toBe("a");
    expect(nameList(["a", "b", "c"])).toBe("a, b and c");
    expect(nameList(["a", "b", "c", "d"], 2)).toBe("a, b and 2 more");
  });
});

describe("a conflict with another person", () => {
  const conflict = (kept: "mine" | "theirs") =>
    entry({
      state: "conflict",
      conflict: {
        files: ["plan.md"],
        kept: { "plan.md": kept },
        from: "anyas-laptop",
        person: "Anya",
        at: "2026-10-30T12:00:00.000Z",
      },
    });

  it("names them and says the person's version is safe", () => {
    expect(conflictLine(conflict("theirs"))).toBe(
      "Anya changed the same file. Your version is saved.",
    );
    expect(conflictLine(conflict("mine"))).toBe(
      "Anya changed the same file. Yours stays here, and theirs is saved.",
    );
  });
});

describe("a project shared with this person", () => {
  it("says whose it is", () => {
    const shared = { team: { id: 12, owner: "misha" } };
    expect(syncLabel(entry({ ...shared, state: "synced", lastSyncedAt: null }))).toBe(
      "Shared by misha.",
    );
    expect(syncLabel(entry({ ...shared, state: "empty" }))).toBe(
      "Shared by misha. Nothing to sync yet.",
    );
  });

  it("offers Bring mine back only when a file here is someone else's version", () => {
    const conflict = (side: "mine" | "theirs") => ({
      files: ["plan.md"],
      kept: { "plan.md": side },
      from: null,
      person: "Anya",
      at: "",
    });
    expect(mineWasReplaced(conflict("theirs"))).toBe(true);
    expect(mineWasReplaced(conflict("mine"))).toBe(false);
    expect(mineWasReplaced(null)).toBe(false);
  });
});

describe("files waiting because of a key", () => {
  it("get their own quiet mark and say why", () => {
    const held = entry({ held: ["config.json"], message: "config.json is waiting" });
    expect(syncMarkOf("synced", ["config.json"])).toBe("held");
    expect(syncMarkOf("synced", [])).toBe("synced");
    expect(syncLabel(held)).toBe("config.json is waiting");
    expect(mostUrgent([entry({}), held])).toBe(held);
    expect(mostUrgent([held, entry({ state: "error" })])?.state).toBe("error");
  });
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

describe("projectKeyCount", () => {
  it("counts a key once, not again for the .env it is in", () => {
    expect(projectKeyCount(1, [".env"])).toBe(1);
    expect(projectKeyCount(0, [".env"])).toBe(0);
  });

  it("adds key files that hold other keys", () => {
    expect(projectKeyCount(2, [".env", "certs/server.pem", "apps/api/.env"])).toBe(4);
  });
});

describe("hostLine", () => {
  const host = {
    provider: "github" as const,
    repository: "misha/site",
    url: "https://github.com/misha/site",
    remote: "origin",
  };

  it("says it plainly, with git's words only in Dev Mode", () => {
    expect(hostLine(host, false)).toBe(
      "Also in your GitHub account. Saved versions go there by themselves.",
    );
    expect(hostLine(host, false)).not.toMatch(/\b(git|commit|branch|push|pull)\b/i);
    expect(hostLine({ ...host, provider: "gitlab" }, false)).toContain("GitLab");
    expect(hostLine(host, true)).toContain("remote origin");
    expect(hostLine(host, true)).toContain("private");
  });
});

describe("a shared project coming here by itself", () => {
  const team = { id: 12, owner: "misha" };
  const row = { name: "notes", updatedAt: null, from: "misha", mode: "git" as const };

  it("brings accepted projects, each once, and not one with nothing saved", () => {
    const rows = [
      { ...row, team },
      { ...row, name: "empty", team: { id: 13, owner: "misha" }, waiting: true },
      { ...row, name: "mine" },
      { ...row, name: "old", team: { id: 14, owner: "misha" } },
    ];
    expect(arrivalsToBring("env", rows, new Set()).map((item) => item.name)).toEqual([
      "notes",
      "old",
    ]);
    expect(arrivalsToBring("env", rows, new Set(["env:12"])).map((item) => item.name)).toEqual([
      "old",
    ]);
    // Another computer of the person's in the same window has its own try.
    expect(arrivalsToBring("other", rows, new Set(["env:12"]))).toHaveLength(2);
  });

  it("says it's here, wherever Accept was", () => {
    for (const afterAccept of [true, false]) {
      expect(arrivalWords("notes", "here", afterAccept)).toEqual({
        type: "success",
        title: "notes is on this computer",
        description: SHARED_PROJECT_HERE,
      });
    }
  });

  it("after Accept never leaves the person without a word", () => {
    expect(arrivalWords("notes", "waiting", true)).toEqual({
      type: "info",
      title: "You're in notes",
      description: "Nothing is saved in notes yet. It comes here once its owner has saved it.",
    });
    expect(arrivalWords("notes", "taken", true)?.description).toContain("Get it here");
    expect(arrivalWords("notes", "gone", true)?.title).toBe("You're in notes");
  });

  it("by itself stays quiet: the row says the rest", () => {
    expect(arrivalWords("notes", "waiting", false)).toBeNull();
    expect(arrivalWords("notes", "taken", false)).toBeNull();
    expect(arrivalWords("notes", "gone", false)).toBeNull();
  });

  it("says the same as the engine about a project with nothing saved", () => {
    expect(sharedWaitingLine("notes")).toBe(
      "Nothing is saved in notes yet. It comes here once its owner has saved it.",
    );
  });
});
