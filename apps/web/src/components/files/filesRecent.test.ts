import type { FilesRecentItem } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  filterRecent,
  groupRecentByDay,
  recentFolderLabel,
  recentSourceLabel,
} from "./filesRecent";
import { effectiveFilesViewMode } from "./FilesTree";
import { editsInline } from "./fileTypes";

const item = (
  path: string,
  at: string,
  source: "opened" | "agent" = "opened",
): FilesRecentItem => ({
  entry: {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    size: 1,
    modifiedAt: at,
    hidden: false,
    isSymlink: false,
  },
  source,
  at,
  threadId: source === "agent" ? "t1" : null,
  threadTitle: source === "agent" ? "Fix the report" : null,
});

describe("groupRecentByDay", () => {
  it("splits into Today, Yesterday and Earlier, keeping the order", () => {
    const now = new Date(2026, 9, 14, 15, 0);
    const groups = groupRecentByDay(
      [
        item("/h/a.md", new Date(2026, 9, 14, 9, 0).toISOString()),
        item("/h/b.md", new Date(2026, 9, 14, 1, 0).toISOString()),
        item("/h/c.md", new Date(2026, 9, 13, 23, 0).toISOString()),
        item("/h/d.md", new Date(2026, 9, 1).toISOString()),
        item("/h/e.md", "garbage"),
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.items.map((x) => x.entry.name)])).toEqual([
      ["Today", ["a.md", "b.md"]],
      ["Yesterday", ["c.md"]],
      ["Earlier", ["d.md", "e.md"]],
    ]);
    expect(groupRecentByDay([], now)).toEqual([]);
  });
});

describe("filterRecent", () => {
  it("keeps one source or all", () => {
    const items = [item("/a", "2026-10-01T00:00:00Z"), item("/b", "2026-10-01T00:00:00Z", "agent")];
    expect(filterRecent(items, "all")).toHaveLength(2);
    expect(filterRecent(items, "agent").map((x) => x.entry.path)).toEqual(["/b"]);
    expect(filterRecent(items, "opened").map((x) => x.entry.path)).toEqual(["/a"]);
  });
});

describe("recentFolderLabel / recentSourceLabel", () => {
  it("names the folder from the home folder", () => {
    expect(recentFolderLabel("/home/u", "/home/u/a.md")).toBe("Home");
    expect(recentFolderLabel("/home/u/", "/home/u/p/docs/a.md")).toBe("Home › p › docs");
    expect(recentFolderLabel("/home/u", "/srv/x/a.md")).toBe("/srv/x");
    expect(recentFolderLabel(null, "/home/u/p/a.md")).toBe("/home/u/p");
  });

  it("says where it came from", () => {
    expect(recentSourceLabel({ source: "opened", threadTitle: null })).toBe("Opened");
    expect(recentSourceLabel({ source: "agent", threadTitle: "Fix the report" })).toBe(
      "Changed by Fix the report",
    );
    expect(recentSourceLabel({ source: "agent", threadTitle: "  " })).toBe("Changed by an agent");
  });
});

describe("effectiveFilesViewMode", () => {
  it("keeps the choice on a computer; a phone gets the list or Recent", () => {
    expect(effectiveFilesViewMode("tree", false)).toBe("tree");
    expect(effectiveFilesViewMode("recent", false)).toBe("recent");
    expect(effectiveFilesViewMode("tree", true)).toBe("list");
    expect(effectiveFilesViewMode("list", true)).toBe("list");
    expect(effectiveFilesViewMode("recent", true)).toBe("recent");
  });
});

describe("editsInline", () => {
  it("opens text you type into straight in the editor", () => {
    expect(editsInline("markdown")).toBe(true);
    expect(editsInline("text")).toBe(true);
    expect(editsInline("code")).toBe(true);
    expect(editsInline("csv")).toBe(false);
    expect(editsInline("html")).toBe(false);
    expect(editsInline("document")).toBe(false);
  });
});
