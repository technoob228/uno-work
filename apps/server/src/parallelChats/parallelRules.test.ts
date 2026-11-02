import { describe, expect, it } from "vitest";

import { classifyConflict, parseMergeTreeOutput } from "./parallelGit.ts";
import {
  autoCopyName,
  autoCopyPath,
  claudeProjectDirName,
  copyLimitRefusal,
  decodeConflictRecord,
  effectiveParallelMode,
  encodeConflictRecord,
  isAutoCopyPath,
  isOwnAutoCopy,
  keptVersionName,
  projectIneligibleReason,
  sessionMove,
  startingTurnClearedBy,
} from "./parallelRules.ts";

describe("parallel rules", () => {
  it("the flag: setting, overridden by the environment; off by default", () => {
    expect(effectiveParallelMode(undefined, {})).toBe("off");
    expect(effectiveParallelMode("nogit", {})).toBe("nogit");
    expect(effectiveParallelMode("nogit", { UNO_WORK_PARALLEL_CHATS: "off" })).toBe("off");
    expect(effectiveParallelMode("off", { UNO_WORK_PARALLEL_CHATS: " NoGit " })).toBe("nogit");
    expect(effectiveParallelMode("off", { UNO_WORK_PARALLEL_CHATS: "yes" })).toBe("off");
  });

  it("a copy's path says whose it is", () => {
    const copy = autoCopyPath({
      worktreesDir: "/w",
      root: "/h/projects/site",
      threadId: "ab-cd-ef-12-34",
    });
    expect(copy).toBe("/w/site/uno-auto-abcdef12");
    expect(autoCopyName("ab-cd-ef-12-34")).toBe("uno-auto-abcdef12");
    expect(isAutoCopyPath("/w", copy)).toBe(true);
    expect(isAutoCopyPath("/w", "/w/site/uno/feature")).toBe(false);
    expect(isAutoCopyPath("/w", "/elsewhere/site/uno-auto-abcdef12")).toBe(false);
    expect(isAutoCopyPath("/w", null)).toBe(false);
    expect(isOwnAutoCopy("/w", copy, "ab-cd-ef-12-34")).toBe(true);
    expect(isOwnAutoCopy("/w", copy, "99999999-0")).toBe(false);
  });

  it("which projects take part", () => {
    const base = {
      mode: "nogit" as const,
      home: "/h",
      isAssistantProject: false,
      repoKind: "uno-git" as const,
    };
    expect(projectIneligibleReason({ ...base, root: "/h/projects/site" })).toBeNull();
    expect(projectIneligibleReason({ ...base, mode: "off", root: "/h/projects/site" })).toBe("off");
    expect(projectIneligibleReason({ ...base, root: "/h" })).toBe("home");
    expect(projectIneligibleReason({ ...base, root: "/h/" })).toBe("home");
    expect(projectIneligibleReason({ ...base, root: "/h/chats" })).toBe("no-project");
    expect(projectIneligibleReason({ ...base, isAssistantProject: true, root: "/h/a" })).toBe(
      "assistant",
    );
    expect(projectIneligibleReason({ ...base, repoKind: "own-git", root: "/h/p" })).toBe("own-git");
    expect(
      projectIneligibleReason({ ...base, mode: "all", repoKind: "own-git", root: "/h/p" }),
    ).toBe("own-git");
    expect(projectIneligibleReason({ ...base, repoKind: "none", root: "/h/p" })).toBe("no-sync");
  });

  it("limits before a copy", () => {
    expect(copyLimitRefusal({ lowDisk: false, liveCopies: 2, fileCount: 99_000 })).toBeNull();
    expect(copyLimitRefusal({ lowDisk: true, liveCopies: 0, fileCount: 1 })).toBe("low-disk");
    expect(copyLimitRefusal({ lowDisk: false, liveCopies: 3, fileCount: 1 })).toBe(
      "too-many-copies",
    );
    expect(copyLimitRefusal({ lowDisk: false, liveCopies: 0, fileCount: 100_001 })).toBe(
      "too-many-files",
    );
    expect(copyLimitRefusal({ lowDisk: false, liveCopies: 0, fileCount: null })).toBeNull();
  });

  it("which old chats can move", () => {
    expect(sessionMove({ hasResumableSession: false, driver: "opencode" })).toBe("fresh");
    expect(sessionMove({ hasResumableSession: true, driver: "claudeAgent" })).toBe(
      "claude-transcript",
    );
    for (const driver of ["codex", "opencode", "uno", "hermes", "cursor", null]) {
      expect(sessionMove({ hasResumableSession: true, driver })).toBe("cannot");
    }
  });

  it("a starting turn is not cleared by the 'ready' of its own session start", () => {
    expect(startingTurnClearedBy("ready")).toBe(false);
    expect(startingTurnClearedBy("starting")).toBe(false);
    expect(startingTurnClearedBy("running")).toBe(true);
    expect(startingTurnClearedBy("error")).toBe(true);
  });

  it("Claude's project folder names", () => {
    expect(claudeProjectDirName("/home/u/.t3/worktrees/my_site/uno-auto-1")).toBe(
      "-home-u--t3-worktrees-my-site-uno-auto-1",
    );
  });

  it("the chat's version of a binary file goes next to the project's", () => {
    expect(keptVersionName("img/logo.png", "New logo")).toBe("img/logo (from New logo).png");
    expect(keptVersionName("Makefile", "a/b: c")).toBe("Makefile (from a b c)");
    expect(keptVersionName(".bin", "")).toBe(".bin (from another chat)");
  });

  it("a conflict record survives its commit message", () => {
    const record = {
      kind: "text" as const,
      files: ["a.md", "б в.md"],
      otherTitle: 'Say "hi"',
      parkedAt: "2026-11-02T03:00:00.000Z",
    };
    expect(decodeConflictRecord(encodeConflictRecord(record))).toEqual(record);
    expect(decodeConflictRecord("nothing")).toBeNull();
  });
});

describe("merge-tree output", () => {
  it("reads the tree, the conflicted paths and their kinds", () => {
    const out = [
      "7a32f3d",
      "b.bin",
      "del.txt",
      "t.txt",
      "кир фа.txt",
      "",
      "1",
      "b.bin",
      "CONFLICT (binary)",
      "warning: Cannot merge binary files",
      "1",
      "b.bin",
      "Auto-merging",
      "Auto-merging b.bin",
      "1",
      "b.bin",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in b.bin",
      "1",
      "del.txt",
      "CONFLICT (modify/delete)",
      "del.txt deleted in x and modified in y.",
      "1",
      "t.txt",
      "Auto-merging",
      "Auto-merging t.txt",
      "1",
      "t.txt",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in t.txt",
      "1",
      "кир фа.txt",
      "CONFLICT (add/add)",
      "CONFLICT (add/add): Merge conflict in кир фа.txt",
      "",
    ].join("\0");
    expect(parseMergeTreeOutput(out, false)).toEqual({
      clean: false,
      tree: "7a32f3d",
      conflicts: [
        { path: "b.bin", kind: "binary" },
        { path: "del.txt", kind: "other" },
        { path: "t.txt", kind: "text" },
        { path: "кир фа.txt", kind: "text" },
      ],
    });
    expect(parseMergeTreeOutput("abc\0", true)).toEqual({ clean: true, tree: "abc" });
  });

  it("a rename on both sides is not a text conflict", () => {
    expect(classifyConflict(new Set(["CONFLICT (rename/rename)"]))).toBe("other");
    expect(classifyConflict(undefined)).toBe("other");
  });
});
