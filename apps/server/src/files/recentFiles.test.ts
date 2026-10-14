import { describe, expect, it } from "vitest";

import {
  addRecentOpened,
  agentChangesFromTurns,
  mergeRecentFiles,
  parseRecentOpened,
  type RecentTurnRow,
} from "./recentFiles.ts";

describe("addRecentOpened", () => {
  it("puts the file on top, once, and keeps at most max", () => {
    const items = [
      { path: "/home/u/a.md", openedAt: "2026-10-01T10:00:00.000Z" },
      { path: "/home/u/b.md", openedAt: "2026-10-01T09:00:00.000Z" },
    ];
    expect(addRecentOpened(items, "/home/u/b.md", "2026-10-02T00:00:00.000Z")).toEqual([
      { path: "/home/u/b.md", openedAt: "2026-10-02T00:00:00.000Z" },
      { path: "/home/u/a.md", openedAt: "2026-10-01T10:00:00.000Z" },
    ]);
    expect(addRecentOpened(items, "/home/u/c.md", "2026-10-02T00:00:00.000Z", 2)).toEqual([
      { path: "/home/u/c.md", openedAt: "2026-10-02T00:00:00.000Z" },
      { path: "/home/u/a.md", openedAt: "2026-10-01T10:00:00.000Z" },
    ]);
  });
});

describe("parseRecentOpened", () => {
  it("drops malformed, relative and duplicate rows and sorts newest first", () => {
    expect(
      parseRecentOpened({
        version: 1,
        items: [
          { path: "/a", openedAt: "2026-10-01T00:00:00.000Z" },
          { path: "rel", openedAt: "2026-10-01T00:00:00.000Z" },
          { path: "/b", openedAt: "not a date" },
          { path: "/c", openedAt: "2026-10-03T00:00:00.000Z" },
          { path: "/a", openedAt: "2026-10-04T00:00:00.000Z" },
          null,
        ],
      }),
    ).toEqual([
      { path: "/c", openedAt: "2026-10-03T00:00:00.000Z" },
      { path: "/a", openedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(parseRecentOpened("garbage")).toEqual([]);
    expect(parseRecentOpened(null)).toEqual([]);
  });
});

const row = (overrides: Partial<RecentTurnRow>): RecentTurnRow => ({
  threadId: "t1",
  threadTitle: "Fix the report",
  worktreePath: null,
  workspaceRoot: "/home/u/project",
  completedAt: "2026-10-05T12:00:00.000Z",
  filesJson: "[]",
  ...overrides,
});

describe("agentChangesFromTurns", () => {

  it("resolves paths against the worktree, else the project", () => {
    const changes = agentChangesFromTurns([
      row({ filesJson: JSON.stringify([{ path: "docs/a.md", kind: "modified" }]) }),
      row({
        threadId: "t2",
        worktreePath: "/home/u/.wt/x",
        filesJson: JSON.stringify([{ path: "b.ts", kind: "modified" }]),
      }),
    ]);
    expect(changes.map((change) => [change.path, change.threadId])).toEqual([
      ["/home/u/project/docs/a.md", "t1"],
      ["/home/u/.wt/x/b.ts", "t2"],
    ]);
  });

  it("skips deleted files, paths climbing out and broken json", () => {
    expect(
      agentChangesFromTurns([
        row({
          filesJson: JSON.stringify([
            { path: "gone.md", kind: "deleted" },
            { path: "../../etc/passwd", kind: "modified" },
            { path: "", kind: "modified" },
          ]),
        }),
        row({ filesJson: "{not json" }),
        row({ workspaceRoot: "relative", filesJson: JSON.stringify([{ path: "a" }]) }),
      ]),
    ).toEqual([]);
  });
});

describe("mergeRecentFiles", () => {
  it("one row per file, the latest event wins, newest first, limited", () => {
    const merged = mergeRecentFiles(
      [
        { path: "/a", openedAt: "2026-10-03T00:00:00.000Z" },
        { path: "/b", openedAt: "2026-10-01T00:00:00.000Z" },
      ],
      [
        { path: "/b", at: "2026-10-02T00:00:00.000Z", threadId: "t", threadTitle: "Chat" },
        { path: "/a", at: "2026-10-02T00:00:00.000Z", threadId: "t", threadTitle: "Chat" },
        { path: "/c", at: "2026-10-04T00:00:00.000Z", threadId: "t", threadTitle: "Chat" },
      ],
      10,
    );
    expect(merged.map((item) => [item.path, item.source])).toEqual([
      ["/c", "agent"],
      ["/a", "opened"],
      ["/b", "agent"],
    ]);
    expect(mergeRecentFiles([], [], 5)).toEqual([]);
    expect(
      mergeRecentFiles(
        [
          { path: "/a", openedAt: "2026-10-03T00:00:00.000Z" },
          { path: "/b", openedAt: "2026-10-02T00:00:00.000Z" },
        ],
        [],
        1,
      ).map((item) => item.path),
    ).toEqual(["/a"]);
  });
});
