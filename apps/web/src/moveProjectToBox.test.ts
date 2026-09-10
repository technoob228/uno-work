import { describe, expect, it, vi } from "vitest";

import {
  describeMoveProjectResult,
  moveProjectDestination,
  moveProjectToBox,
  type MoveProjectToBoxDeps,
  type MoveProjectToBoxStep,
} from "./moveProjectToBox";

function makeDeps(overrides: Partial<MoveProjectToBoxDeps> = {}) {
  const steps: MoveProjectToBoxStep[] = [];
  const deps: MoveProjectToBoxDeps = {
    ensureTargetConnected: vi.fn(async () => {}),
    cloneRepository: vi.fn(async ({ destinationPath }) => ({ cwd: destinationPath })),
    readSourceFile: vi.fn(async () => ({ content: "TOKEN=1", encoding: "utf8" as const })),
    writeTargetFile: vi.fn(async () => undefined),
    createProject: vi.fn(async () => {}),
    onStep: (step) => steps.push(step),
    ...overrides,
  };
  return { deps, steps };
}

const CLONE_INPUT = {
  mode: "clone" as const,
  projectName: "My App",
  sourceCwd: "/Users/me/projects/my-app",
  remoteUrl: "git@github.com:me/my-app.git",
  targetBaseDirectory: "~/projects",
  copyEnv: true,
};

describe("moveProjectDestination", () => {
  it("normalizes the project name and joins it onto the target workspace root", () => {
    expect(
      moveProjectDestination({ projectName: "My App (v2)", targetBaseDirectory: "~/projects" }),
    ).toEqual({ title: "My-App-v2", destinationPath: "~/projects/My-App-v2" });
  });

  it("falls back to a usable name when nothing survives normalization", () => {
    expect(
      moveProjectDestination({ projectName: "///", targetBaseDirectory: "~/projects" }),
    ).toEqual({ title: "project", destinationPath: "~/projects/project" });
  });
});

describe("moveProjectToBox", () => {
  it("connects, clones, copies .env and creates the project in order", async () => {
    const { deps, steps } = makeDeps();
    const result = await moveProjectToBox(deps, CLONE_INPUT);

    expect(steps).toEqual(["connecting", "cloning", "copying-env", "creating-project"]);
    expect(deps.cloneRepository).toHaveBeenCalledWith({
      remoteUrl: "git@github.com:me/my-app.git",
      destinationPath: "~/projects/My-App",
    });
    expect(deps.readSourceFile).toHaveBeenCalledWith("/Users/me/projects/my-app/.env");
    expect(deps.writeTargetFile).toHaveBeenCalledWith({
      cwd: "~/projects/My-App",
      relativePath: ".env",
      contents: "TOKEN=1",
      encoding: "utf8",
    });
    expect(deps.createProject).toHaveBeenCalledWith({
      cwd: "~/projects/My-App",
      title: "My-App",
    });
    expect(result).toEqual({
      mode: "clone",
      title: "My-App",
      cwd: "~/projects/My-App",
      envCopied: true,
      envSkippedReason: null,
    });
  });

  it("uses the cwd the clone actually reported", async () => {
    const { deps } = makeDeps({
      cloneRepository: vi.fn(async () => ({ cwd: "/home/unowork/projects/My-App" })),
    });
    const result = await moveProjectToBox(deps, CLONE_INPUT);

    expect(result.cwd).toBe("/home/unowork/projects/My-App");
    expect(deps.writeTargetFile).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/unowork/projects/My-App" }),
    );
    expect(deps.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/unowork/projects/My-App" }),
    );
  });

  it("skips the copy entirely when the user unticked it", async () => {
    const { deps, steps } = makeDeps();
    const result = await moveProjectToBox(deps, { ...CLONE_INPUT, copyEnv: false });

    expect(deps.readSourceFile).not.toHaveBeenCalled();
    expect(deps.writeTargetFile).not.toHaveBeenCalled();
    expect(steps).toEqual(["connecting", "cloning", "creating-project"]);
    expect(result.envCopied).toBe(false);
    expect(result.envSkippedReason).toBeNull();
  });

  it("still creates the project when there is no .env to copy", async () => {
    const { deps } = makeDeps({ readSourceFile: vi.fn(async () => null) });
    const result = await moveProjectToBox(deps, CLONE_INPUT);

    expect(result.envCopied).toBe(false);
    expect(result.envSkippedReason).toBe("no .env file in the project root");
    expect(deps.createProject).toHaveBeenCalledTimes(1);
  });

  it("reports a failed .env copy instead of aborting the move", async () => {
    const { deps } = makeDeps({
      writeTargetFile: vi.fn(async () => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const result = await moveProjectToBox(deps, CLONE_INPUT);

    expect(result.envCopied).toBe(false);
    expect(result.envSkippedReason).toContain("EACCES");
    expect(deps.createProject).toHaveBeenCalledTimes(1);
  });

  it("carries a base64 .env across unchanged", async () => {
    const { deps } = makeDeps({
      readSourceFile: vi.fn(async () => ({ content: "QUJD", encoding: "base64" as const })),
    });
    await moveProjectToBox(deps, CLONE_INPUT);

    expect(deps.writeTargetFile).toHaveBeenCalledWith(
      expect.objectContaining({ contents: "QUJD", encoding: "base64" }),
    );
  });

  it("creates an empty project without cloning in empty mode", async () => {
    const { deps, steps } = makeDeps();
    const result = await moveProjectToBox(deps, {
      ...CLONE_INPUT,
      mode: "empty",
      remoteUrl: null,
    });

    expect(deps.cloneRepository).not.toHaveBeenCalled();
    expect(steps).toEqual(["connecting", "copying-env", "creating-project"]);
    expect(result).toMatchObject({ mode: "empty", cwd: "~/projects/My-App", envCopied: true });
  });

  it("refuses to clone without a remote", async () => {
    const { deps } = makeDeps();
    await expect(moveProjectToBox(deps, { ...CLONE_INPUT, remoteUrl: "   " })).rejects.toThrow(
      /no git remote/,
    );
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("does not create a project when the clone fails", async () => {
    const { deps } = makeDeps({
      cloneRepository: vi.fn(async () => {
        throw new Error("repository not found");
      }),
    });
    await expect(moveProjectToBox(deps, CLONE_INPUT)).rejects.toThrow(/repository not found/);
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.writeTargetFile).not.toHaveBeenCalled();
  });

  it("fails before doing anything when the target cannot be connected", async () => {
    const { deps } = makeDeps({
      ensureTargetConnected: vi.fn(async () => {
        throw new Error("box is asleep");
      }),
    });
    await expect(moveProjectToBox(deps, CLONE_INPUT)).rejects.toThrow(/box is asleep/);
    expect(deps.cloneRepository).not.toHaveBeenCalled();
  });
});

describe("describeMoveProjectResult", () => {
  it("says what landed and what did not", () => {
    expect(
      describeMoveProjectResult({
        mode: "clone",
        title: "app",
        cwd: "~/projects/app",
        envCopied: true,
        envSkippedReason: null,
      }),
    ).toBe(
      "Cloned into ~/projects/app · .env copied · uncommitted changes stayed on this machine.",
    );

    expect(
      describeMoveProjectResult({
        mode: "empty",
        title: "app",
        cwd: "~/projects/app",
        envCopied: false,
        envSkippedReason: "no .env file in the project root",
      }),
    ).toBe(
      "Created an empty project at ~/projects/app · .env not copied (no .env file in the project root).",
    );
  });
});
