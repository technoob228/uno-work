import { describe, expect, it } from "vitest";

import { planUpload } from "./firstProject";
import {
  findSkipSuggestions,
  leftOutHotspots,
  leftOutListText,
  skipFoldersFor,
  skippedGroupsLine,
  summarizeUploadPlan,
  timeLeftLine,
  uploadPercent,
  uploadRate,
} from "./projectUploadSummary";

const limits = { maxFileBytes: 100, maxTotalBytes: 10_000, maxFileCount: 2, filterIgnored: true };

describe("summarizeUploadPlan", () => {
  it("separates folders skipped on purpose from files the limits cut", () => {
    const plan = planUpload(
      [
        { relativePath: "node_modules/a.js", size: 1 },
        { relativePath: "node_modules/b.js", size: 1 },
        { relativePath: ".git/HEAD", size: 1 },
        { relativePath: "src/one.ts", size: 1 },
        { relativePath: "src/two.ts", size: 1 },
        { relativePath: "code/wt/three.ts", size: 1 },
        { relativePath: "video.mov", size: 500 },
      ],
      limits,
    );
    const summary = summarizeUploadPlan(plan, ["Python environments"]);
    expect(summary.skippedGroups).toEqual([
      { label: "Python environments", files: null },
      { label: "node_modules", files: 2 },
      { label: ".git", files: 1 },
    ]);
    expect(summary.skippedFiles).toBe(3);
    expect(summary.tooLarge).toEqual(["video.mov"]);
    expect(summary.leftOut).toEqual(["code/wt/three.ts"]);
    expect(summary.leftOutBy).toBe("files");
    expect(summary.wantedFiles).toBe(3);
    expect(leftOutHotspots(summary.leftOut)).toEqual([{ folder: "code/wt", files: 1 }]);
    const text = leftOutListText({ summary, folderName: "luckyip" });
    expect(text).toContain("code/wt/three.ts");
    expect(text).toContain("video.mov");
    expect(text).toContain("up to 20,000 files");
  });

  it("names a few skipped folders and counts the rest", () => {
    const groups = ["a", "b", "c", "d", "e"].map((label) => ({ label, files: 1 }));
    expect(skippedGroupsLine(groups)).toBe("a, b, c and 2 more");
    expect(skippedGroupsLine(groups.slice(0, 2))).toBe("a and b");
  });
});

describe("findSkipSuggestions", () => {
  it("finds vendored dependencies and git worktrees, but not submodules", async () => {
    const text = (value: string) => new Blob([value]);
    const suggestions = await findSkipSuggestions([
      { relativePath: "svc/vendor/modules.txt" },
      { relativePath: "svc/vendor/github.com/x/y.go" },
      { relativePath: "php/vendor/autoload.php" },
      {
        relativePath: "wt/feature/.git",
        blob: text("gitdir: /home/me/p/.git/worktrees/feature\n"),
      },
      { relativePath: "libs/sub/.git", blob: text("gitdir: ../../.git/modules/libs/sub\n") },
      { relativePath: "vendorish/readme.md" },
    ]);
    expect(suggestions.map((entry) => [entry.id, entry.folders])).toEqual([
      ["vendor", ["php/vendor", "svc/vendor"]],
      ["worktrees", ["wt/feature"]],
    ]);
    const map = skipFoldersFor(suggestions, new Set(["worktrees"]));
    expect([...map.entries()]).toEqual([["wt/feature", "git worktrees"]]);
  });
});

describe("progress", () => {
  it("goes by bytes, so a few big files don't look like 1%", () => {
    expect(
      uploadPercent({ sentBytes: 167, totalBytes: 1400, completedFiles: 211, totalFiles: 20000 }),
    ).toBe(11);
    expect(uploadPercent({ sentBytes: 0, totalBytes: 0, completedFiles: 1, totalFiles: 4 })).toBe(
      25,
    );
  });

  it("says the time left from the recent pace of bytes and files together", () => {
    const samples = [
      { at: 0, sentBytes: 0, completedFiles: 0 },
      { at: 10_000, sentBytes: 10_000_000, completedFiles: 100 },
    ];
    // 50% of the bytes, 10% of the files: 30% in 10 s, 70% left → about 23 s.
    const rate = uploadRate(samples, { bytes: 20_000_000, files: 1000 });
    expect(rate?.bytesPerSecond).toBe(1_000_000);
    expect(rate?.secondsLeft).toBeCloseTo(23.33, 1);
    expect(timeLeftLine(600)).toBe("about 10 min left");
    expect(timeLeftLine(30)).toBe("less than a minute left");
    expect(timeLeftLine(3 * 3600 + 600)).toBe("about 3 h 10 min left");
    expect(uploadRate(samples.slice(0, 1), { bytes: 1, files: 1 })).toBeNull();
  });
});
