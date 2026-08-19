import { describe, expect, it, vi } from "vitest";

import { TUTORIAL_FILES } from "./firstProject";
import {
  runCloneFirstProject,
  runTutorialFirstProject,
  runUploadFirstProject,
  type FirstProjectFile,
  type FirstProjectRunnerDeps,
} from "./firstProjectRunner";

function makeDeps(overrides: Partial<FirstProjectRunnerDeps> = {}) {
  const writes: Array<{ cwd: string; relativePath: string; encoding?: string }> = [];
  const created: Array<{ cwd: string; title: string }> = [];
  const deps: FirstProjectRunnerDeps = {
    cloneRepository: vi.fn(async ({ destinationPath }) => ({ cwd: destinationPath })),
    writeFile: vi.fn(async (input) => {
      writes.push({
        cwd: input.cwd,
        relativePath: input.relativePath,
        encoding: input.encoding,
      });
    }),
    createProject: vi.fn(async (input) => {
      created.push(input);
    }),
    ...overrides,
  };
  return { deps, writes, created };
}

function makeFile(rootRelativePath: string, size = 4): FirstProjectFile {
  return {
    rootRelativePath,
    size,
    readBase64: async () => "ZGF0YQ==",
  };
}

describe("runCloneFirstProject", () => {
  it("clones into the workspace and registers the project", async () => {
    const { deps, created } = makeDeps();
    const result = await runCloneFirstProject(deps, {
      remoteUrl: "uno/work",
      baseDirectory: "/home/uno/projects",
    });

    expect(deps.cloneRepository).toHaveBeenCalledWith({
      remoteUrl: "https://github.com/uno/work.git",
      destinationPath: "/home/uno/projects/work",
    });
    expect(result).toMatchObject({ cwd: "/home/uno/projects/work", title: "work" });
    expect(created).toEqual([{ cwd: "/home/uno/projects/work", title: "work" }]);
  });

  it("falls back to the requested path when the server returns no cwd", async () => {
    const { deps } = makeDeps({ cloneRepository: vi.fn(async () => ({ cwd: "  " })) });
    const result = await runCloneFirstProject(deps, {
      remoteUrl: "https://github.com/uno/work.git",
      baseDirectory: "/home/uno/projects",
    });
    expect(result.cwd).toBe("/home/uno/projects/work");
  });
});

describe("runUploadFirstProject", () => {
  it("writes accepted files relative to the project root", async () => {
    const { deps, writes, created } = makeDeps();
    const progress: Array<{ completed: number; total: number }> = [];

    const result = await runUploadFirstProject(
      { ...deps, onProgress: (value) => progress.push(value) },
      {
        files: [makeFile("my-app/src/index.ts"), makeFile("my-app/README.md")],
        baseDirectory: "/home/uno/projects",
        projectName: "my-app",
      },
    );

    expect(created).toEqual([{ cwd: "/home/uno/projects/my-app", title: "my-app" }]);
    expect(writes.map((write) => write.relativePath)).toEqual(["src/index.ts", "README.md"]);
    expect(writes.every((write) => write.encoding === "base64")).toBe(true);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });
    expect(result.uploadPlan?.skipped).toEqual([]);
  });

  it("never reads files it skipped", async () => {
    const readBase64 = vi.fn(async () => "ZGF0YQ==");
    const { deps, writes } = makeDeps();

    const result = await runUploadFirstProject(deps, {
      files: [
        { rootRelativePath: "my-app/node_modules/left-pad/index.js", size: 10, readBase64 },
        makeFile("my-app/app.ts"),
      ],
      baseDirectory: "/home/uno/projects",
      projectName: "my-app",
    });

    expect(readBase64).not.toHaveBeenCalled();
    expect(writes.map((write) => write.relativePath)).toEqual(["app.ts"]);
    expect(result.uploadPlan?.skipped).toHaveLength(1);
  });

  it("still creates the project when everything is skipped", async () => {
    const { deps, created, writes } = makeDeps();
    await runUploadFirstProject(deps, {
      files: [makeFile("my-app/.git/config")],
      baseDirectory: "/home/uno/projects",
      projectName: "my-app",
    });
    expect(created).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});

describe("runTutorialFirstProject", () => {
  it("seeds the tutorial files as utf8", async () => {
    const { deps, writes, created } = makeDeps();
    const result = await runTutorialFirstProject(deps, { baseDirectory: "/home/uno/projects" });

    expect(created).toEqual([
      { cwd: "/home/uno/projects/uno-work-tutorial", title: "uno-work-tutorial" },
    ]);
    expect(writes.map((write) => write.relativePath)).toEqual(
      TUTORIAL_FILES.map((file) => file.relativePath),
    );
    expect(writes.every((write) => write.encoding === "utf8")).toBe(true);
    expect(result.cwd).toBe("/home/uno/projects/uno-work-tutorial");
  });
});
