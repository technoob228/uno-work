import { describe, expect, it } from "vitest";

import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILE_COUNT,
  expandGitRemoteUrl,
  inferProjectNameFromGitUrl,
  inferProjectNameFromUpload,
  isLikelyGitRemoteUrl,
  joinWorkspacePath,
  normalizeProjectName,
  pickFirstProjectModelSelection,
  planUpload,
  stripUploadRootSegment,
} from "./firstProject";

describe("normalizeProjectName", () => {
  it("keeps safe characters and drops the rest", () => {
    expect(normalizeProjectName("  My Project! ")).toBe("My-Project");
    expect(normalizeProjectName("a/b\\c")).toBe("a-b-c");
    expect(normalizeProjectName("---")).toBe("");
  });
});

describe("git remote parsing", () => {
  it("recognises the shapes users paste", () => {
    expect(isLikelyGitRemoteUrl("https://github.com/uno/work.git")).toBe(true);
    expect(isLikelyGitRemoteUrl("git@github.com:uno/work.git")).toBe(true);
    expect(isLikelyGitRemoteUrl("uno/work")).toBe(true);
    expect(isLikelyGitRemoteUrl("not a url")).toBe(false);
    expect(isLikelyGitRemoteUrl("")).toBe(false);
  });

  it("expands GitHub shorthand only", () => {
    expect(expandGitRemoteUrl("uno/work")).toBe("https://github.com/uno/work.git");
    expect(expandGitRemoteUrl("https://gitlab.com/uno/work.git")).toBe(
      "https://gitlab.com/uno/work.git",
    );
  });

  it("infers the project name from any remote shape", () => {
    expect(inferProjectNameFromGitUrl("https://github.com/uno/work.git")).toBe("work");
    expect(inferProjectNameFromGitUrl("git@github.com:uno/work.git")).toBe("work");
    expect(inferProjectNameFromGitUrl("https://github.com/uno/work/")).toBe("work");
    expect(inferProjectNameFromGitUrl("uno/deep-thought")).toBe("deep-thought");
  });
});

describe("joinWorkspacePath", () => {
  it("joins with a single separator", () => {
    expect(joinWorkspacePath("/home/uno/projects", "work")).toBe("/home/uno/projects/work");
    expect(joinWorkspacePath("/home/uno/projects/", "/work")).toBe("/home/uno/projects/work");
    expect(joinWorkspacePath("", "work")).toBe("work");
  });
});

describe("stripUploadRootSegment", () => {
  it("removes the picker's root directory", () => {
    expect(stripUploadRootSegment("my-app/src/index.ts")).toBe("src/index.ts");
    expect(stripUploadRootSegment("index.ts")).toBe("index.ts");
  });
});

describe("planUpload", () => {
  it("keeps ordinary files", () => {
    const plan = planUpload([
      { relativePath: "src/index.ts", size: 100 },
      { relativePath: "README.md", size: 20 },
    ]);
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual(["src/index.ts", "README.md"]);
    expect(plan.totalBytes).toBe(120);
    expect(plan.skipped).toEqual([]);
  });

  it("skips vcs metadata, dependency trees and OS junk", () => {
    const plan = planUpload([
      { relativePath: ".git/config", size: 10 },
      { relativePath: "node_modules/left-pad/index.js", size: 10 },
      { relativePath: "src/.DS_Store", size: 10 },
      { relativePath: "src/app.ts", size: 10 },
    ]);
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual(["src/app.ts"]);
    expect(plan.skipped.every((entry) => entry.reason === "ignored")).toBe(true);
  });

  it("rejects path traversal", () => {
    const plan = planUpload([{ relativePath: "../../etc/passwd", size: 10 }]);
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("unsafe-path");
  });

  it("skips oversized files instead of failing the whole upload", () => {
    const plan = planUpload([
      { relativePath: "huge.bin", size: UPLOAD_MAX_FILE_BYTES + 1 },
      { relativePath: "small.txt", size: 1 },
    ]);
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual(["small.txt"]);
    expect(plan.skipped[0]).toEqual({ relativePath: "huge.bin", reason: "too-large" });
  });

  it("caps the file count", () => {
    const candidates = Array.from({ length: UPLOAD_MAX_FILE_COUNT + 5 }, (_unused, index) => ({
      relativePath: `file-${index}.txt`,
      size: 1,
    }));
    const plan = planUpload(candidates);
    expect(plan.accepted).toHaveLength(UPLOAD_MAX_FILE_COUNT);
    expect(plan.skipped).toHaveLength(5);
    expect(plan.skipped.every((entry) => entry.reason === "over-budget")).toBe(true);
  });
});

describe("pickFirstProjectModelSelection", () => {
  const fallback = { instanceId: "codex", model: "gpt-5.4" };

  it("prefers the bundled Uno gateway", () => {
    const selection = pickFirstProjectModelSelection(
      [
        { instanceId: "claude", status: "ready", models: [{ slug: "sonnet" }] },
        { instanceId: "uno", status: "ready", models: [{ slug: "uno/opus" }] },
      ],
      fallback,
    );
    expect(selection).toEqual({ instanceId: "uno", model: "uno/opus" });
  });

  it("takes any ready provider when Uno is missing", () => {
    const selection = pickFirstProjectModelSelection(
      [
        { instanceId: "claude", status: "error", models: [{ slug: "sonnet" }] },
        { instanceId: "codex", status: "ready", models: [{ slug: "gpt-5.4" }] },
      ],
      fallback,
    );
    expect(selection).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  });

  it("falls back when nothing is ready or nothing has models", () => {
    expect(pickFirstProjectModelSelection([], fallback)).toEqual(fallback);
    expect(
      pickFirstProjectModelSelection(
        [{ instanceId: "uno", status: "ready", models: [] }],
        fallback,
      ),
    ).toEqual(fallback);
  });
});

describe("inferProjectNameFromUpload", () => {
  it("uses the dropped directory name", () => {
    expect(inferProjectNameFromUpload([{ rootRelativePath: "my-app/src/index.ts" }])).toBe(
      "my-app",
    );
  });

  it("falls back when individual files were picked", () => {
    expect(inferProjectNameFromUpload([{ rootRelativePath: "notes.md" }])).toBe("uploaded-files");
    expect(inferProjectNameFromUpload([])).toBe("uploaded-files");
  });
});

describe("planUpload — what a big project leaves out", () => {
  const limits = {
    maxFileBytes: 1000,
    maxTotalBytes: 10_000,
    maxFileCount: 3,
    filterIgnored: true,
  };

  it("skips Python environments by name or by pyvenv.cfg, and says which folder", () => {
    const plan = planUpload(
      [
        { relativePath: "lab/camo-venv/lib/x.py", size: 1 },
        { relativePath: "lab/.venv-sweep/bin/python", size: 1 },
        { relativePath: "lab/env311/pyvenv.cfg", size: 1 },
        { relativePath: "lab/env311/lib/site.py", size: 1 },
        { relativePath: "lib/site-packages/y.py", size: 1 },
        { relativePath: "web/.nuxt/app.js", size: 1 },
        { relativePath: "main.py", size: 1 },
      ],
      limits,
    );
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual(["main.py"]);
    const folders = plan.skipped.map((entry) => entry.folder);
    expect(folders).toEqual([
      "Python environments",
      "Python environments",
      "Python environments",
      "Python environments",
      "Python environments",
      ".nuxt",
    ]);
  });

  it("keeps folders that only look like a venv", () => {
    const plan = planUpload(
      [
        { relativePath: "src/environment/a.ts", size: 1 },
        { relativePath: "src/prevent/b.ts", size: 1 },
      ],
      limits,
    );
    expect(plan.accepted).toHaveLength(2);
  });

  it("marks what the limits cut, by which limit", () => {
    const plan = planUpload(
      [
        { relativePath: "a", size: 1 },
        { relativePath: "b", size: 1 },
        { relativePath: "c", size: 1 },
        { relativePath: "d", size: 1 },
      ],
      limits,
    );
    expect(plan.skipped).toEqual([{ relativePath: "d", reason: "over-budget", limit: "files" }]);
    const bytes = planUpload(
      [
        { relativePath: "a", size: 900 },
        { relativePath: "b", size: 900 },
      ],
      { ...limits, maxTotalBytes: 1000 },
    );
    expect(bytes.skipped).toEqual([{ relativePath: "b", reason: "over-budget", limit: "bytes" }]);
  });

  it("leaves out folders the person chose to skip", () => {
    const plan = planUpload(
      [
        { relativePath: "svc/vendor/x.go", size: 1 },
        { relativePath: "svc/main.go", size: 1 },
      ],
      { ...limits, skipFolders: new Map([["svc/vendor", "vendor"]]) },
    );
    expect(plan.accepted.map((entry) => entry.relativePath)).toEqual(["svc/main.go"]);
    expect(plan.skipped[0]).toMatchObject({ reason: "ignored", folder: "vendor" });
  });
});
