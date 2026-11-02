import type { PullRequestDiffFile } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { filesMatchingSearch, fileTree, patchTextByFile } from "./pullRequestFiles.logic";

const file = (path: string): PullRequestDiffFile =>
  ({ path, additions: 1, deletions: 0, viewed: "unviewed" }) as PullRequestDiffFile;

describe("fileTree", () => {
  it("folds a chain of single folders and lists folders first", () => {
    const tree = fileTree([file("README.md"), file("src/web/a.ts"), file("src/web/b.ts")]);
    expect(tree.map((node) => node.name)).toEqual(["src/web", "README.md"]);
    const folder = tree[0];
    expect(folder?.kind === "directory" && folder.children.map((node) => node.path)).toEqual([
      "src/web/a.ts",
      "src/web/b.ts",
    ]);
  });
});

describe("search", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-Lemonade",
    "+Iced tea",
    " unchanged words",
    "diff --git a/b.txt b/b.txt",
    "+++ b/b.txt",
    "+nothing",
  ].join("\n");

  it("finds changed lines, not the context around them", () => {
    const texts = patchTextByFile(patch);
    const files = [file("a.txt"), file("b.txt")];
    expect(filesMatchingSearch(files, texts, "ICED").map((f) => f.path)).toEqual(["a.txt"]);
    expect(filesMatchingSearch(files, texts, "unchanged")).toEqual([]);
    expect(filesMatchingSearch(files, texts, "b.txt").map((f) => f.path)).toEqual(["b.txt"]);
    expect(filesMatchingSearch(files, texts, "  ")).toHaveLength(2);
  });
});
