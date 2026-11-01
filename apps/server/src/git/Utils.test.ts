import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isCheckpointWorkspace } from "./Utils.ts";

describe("isCheckpointWorkspace", () => {
  const dirs: string[] = [];
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-workspace-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    return dir;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a repository is a workspace, a plain folder isn't", () => {
    const dir = repo();
    expect(isCheckpointWorkspace(dir)).toBe(true);
    rmSync(join(dir, ".git"), { recursive: true });
    expect(isCheckpointWorkspace(dir)).toBe(false);
  });

  it("the home folder isn't one, even with a stray .git and a trailing slash", () => {
    const home = repo();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(isCheckpointWorkspace(home)).toBe(false);
    expect(isCheckpointWorkspace(`${home}/`)).toBe(false);
  });
});
