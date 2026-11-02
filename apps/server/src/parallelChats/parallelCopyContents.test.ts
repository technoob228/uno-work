import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { copyClaudeTranscript, copyEnvFiles, linkNodeModules } from "./parallelCopyContents.ts";
import { projectFolderOfCopy } from "./parallelGit.ts";
import { claudeProjectDirName } from "./parallelRules.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "uno-parallel-contents-")));
  dirs.push(dir);
  return dir;
};
const write = (file: string, text: string) => {
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("what a copy gets", () => {
  it(".env files: copied, an existing one stays", async () => {
    const dir = temp();
    const root = nodePath.join(dir, "root");
    const copy = nodePath.join(dir, "copy");
    write(nodePath.join(root, ".env"), "A=1\n");
    write(nodePath.join(root, "api", ".env.local"), "B=2\n");
    write(nodePath.join(copy, "api", ".env.local"), "B=mine\n");
    const copied = await Effect.runPromise(
      copyEnvFiles(root, copy, [".env", "api/.env.local", "../x"]),
    );
    expect(copied).toBe(1);
    expect(readFileSync(nodePath.join(copy, ".env"), "utf8")).toBe("A=1\n");
    expect(readFileSync(nodePath.join(copy, "api", ".env.local"), "utf8")).toBe("B=mine\n");
  });

  it.runIf(process.platform === "linux")(
    "node_modules: hard links, the package managers' own files get their own inode",
    async () => {
      const dir = temp();
      const root = nodePath.join(dir, "root");
      const copy = nodePath.join(dir, "copy");
      write(nodePath.join(root, "node_modules", "x", "index.js"), "1\n");
      write(nodePath.join(root, "node_modules", ".package-lock.json"), "{}\n");
      write(nodePath.join(root, "node_modules", ".modules.yaml"), "a: 1\n");
      mkdirSync(copy, { recursive: true });
      expect(await Effect.runPromise(linkNodeModules(root, copy))).toBe(true);
      const ino = (base: string, file: string) =>
        statSync(nodePath.join(base, "node_modules", file)).ino;
      expect(ino(copy, "x/index.js")).toBe(ino(root, "x/index.js"));
      expect(ino(copy, ".package-lock.json")).not.toBe(ino(root, ".package-lock.json"));
      expect(ino(copy, ".modules.yaml")).not.toBe(ino(root, ".modules.yaml"));
      writeFileSync(nodePath.join(copy, "node_modules", ".package-lock.json"), "changed\n");
      expect(readFileSync(nodePath.join(root, "node_modules", ".package-lock.json"), "utf8")).toBe(
        "{}\n",
      );
      // Already there: left alone.
      expect(await Effect.runPromise(linkNodeModules(root, copy))).toBe(false);
    },
  );

  it("Claude's transcript: found in any config folder, copied under the copy's name", async () => {
    const dir = temp();
    const configA = nodePath.join(dir, "claude-a");
    const configB = nodePath.join(dir, "claude-b");
    const from = "/home/u/projects/my.site";
    const to = "/home/u/.t3/worktrees/my.site/uno-auto-12345678";
    const id = "0b3c8f2e-1111-4222-8333-444455556666";
    write(nodePath.join(configB, "projects", claudeProjectDirName(from), `${id}.jsonl`), "{}\n");
    const ok = await Effect.runPromise(
      copyClaudeTranscript({ configDirs: [configA, configB], sessionId: id, from, to }),
    );
    expect(ok).toBe(true);
    expect(
      readFileSync(
        nodePath.join(configB, "projects", claudeProjectDirName(to), `${id}.jsonl`),
        "utf8",
      ),
    ).toBe("{}\n");
    const missing = await Effect.runPromise(
      copyClaudeTranscript({ configDirs: [configA], sessionId: id, from, to }),
    );
    expect(missing).toBe(false);
    expect(
      await Effect.runPromise(
        copyClaudeTranscript({ configDirs: [configB], sessionId: "../../x", from, to }),
      ),
    ).toBe(false);
  });

  it("a path in a copy of a project without git leads back to the project folder", async () => {
    const dir = temp();
    const root = nodePath.join(dir, "projects", "site");
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", nodePath.join(root, ".uno-git")]);
    execFileSync("git", [
      "--git-dir",
      nodePath.join(root, ".uno-git"),
      "config",
      "core.bare",
      "false",
    ]);
    write(nodePath.join(root, "a.md"), "a\n");
    const env = {
      ...process.env,
      GIT_DIR: nodePath.join(root, ".uno-git"),
      GIT_WORK_TREE: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    };
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: root, env });
    const copy = nodePath.join(dir, "worktrees", "site", "uno-auto-1");
    execFileSync("git", ["worktree", "add", "-q", "--detach", copy, "HEAD"], { cwd: root, env });
    mkdirSync(nodePath.join(copy, "sub"), { recursive: true });
    expect(await projectFolderOfCopy(nodePath.join(copy, "sub"))).toBe(root);
    expect(await projectFolderOfCopy(copy)).toBe(root);
    expect(await projectFolderOfCopy(root)).toBeNull();
    const own = nodePath.join(dir, "own");
    mkdirSync(own);
    execFileSync("git", ["init", "-q"], { cwd: own });
    expect(await projectFolderOfCopy(own)).toBeNull();
  });
});
