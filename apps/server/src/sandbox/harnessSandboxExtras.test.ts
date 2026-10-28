import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeProjectDirName,
  claudeSandboxExtras,
  codexSandboxExtras,
  hermesSandboxExtras,
  topLevelLinkTargets,
} from "./harnessSandboxExtras.ts";

const HOME = "/home/unowork";

describe("claudeSandboxExtras", () => {
  it("encodes a working folder the way Claude Code names its session folder", () => {
    expect(claudeProjectDirName("/home/unowork/projects/my.shop")).toBe(
      "-home-unowork-projects-my-shop",
    );
  });

  it("binds ~/.claude, hides other projects' transcripts, keeps the sandbox's own", () => {
    const extras = claudeSandboxExtras({
      claudeHome: HOME,
      workDirs: [`${HOME}/projects/shop`, `${HOME}/projects/shop`],
    });
    const own = `${HOME}/.claude/projects/-home-unowork-projects-shop`;
    expect(extras.ensureDirs).toEqual([`${HOME}/.claude`, `${HOME}/.claude/projects`, own]);
    expect(extras.mounts[0]).toEqual({ kind: "rw", path: `${HOME}/.claude` });
    expect(extras.mounts).toContainEqual({ kind: "hide", path: `${HOME}/.claude/projects` });
    expect(extras.mounts).toContainEqual({ kind: "hide", path: `${HOME}/.claude/history.jsonl` });
    expect(extras.mounts).toContainEqual({ kind: "hide", path: `${HOME}/.claude/file-history` });
    expect(extras.mounts.at(-1)).toEqual({ kind: "rw", path: own });
    // ~/.claude.json (every project's settings and MCP servers) is never bound.
    expect(extras.mounts.some((mount) => mount.path.endsWith(".claude.json"))).toBe(false);
  });
});

describe("codexSandboxExtras", () => {
  it("binds the Codex home and where its links point, hides prompt history", () => {
    expect(
      codexSandboxExtras({ codexHome: `${HOME}/.codex`, linkTargets: ["/shared/auth.json"] }),
    ).toEqual({
      ensureDirs: [`${HOME}/.codex`],
      mounts: [
        { kind: "rw", path: `${HOME}/.codex` },
        { kind: "rw", path: "/shared/auth.json" },
        { kind: "hide", path: `${HOME}/.codex/history.jsonl` },
      ],
    });
  });
});

describe("hermesSandboxExtras", () => {
  const shared = "/var/lib/uno-work/userdata/hermes-home-hermes";
  const threadHome = `${shared}/threads/thread-1`;

  it("binds the chat's home inside the shared one, other chats hidden", () => {
    const extras = hermesSandboxExtras({
      threadHome,
      sharedHome: shared,
      skillsDirs: [`${HOME}/.claude/skills`],
    });
    expect(extras.mounts).toEqual([
      { kind: "rw", path: shared },
      { kind: "hide", path: `${shared}/threads` },
      { kind: "hide", path: `${shared}/state.db` },
      { kind: "hide", path: `${shared}/state.db-wal` },
      { kind: "hide", path: `${shared}/state.db-shm` },
      { kind: "hide", path: `${shared}/sessions` },
      { kind: "hide", path: `${shared}/logs` },
      { kind: "hide", path: `${shared}/memories` },
      { kind: "rw", path: threadHome },
      { kind: "ro", path: `${HOME}/.claude/skills` },
    ]);
    expect(extras.ensureDirs).toEqual([threadHome]);
  });

  it("on the person's Claude plan brings Claude Code's state along", () => {
    const extras = hermesSandboxExtras({
      threadHome,
      sharedHome: shared,
      skillsDirs: [],
      claude: { claudeHome: HOME, workDirs: [`${HOME}/projects/shop`] },
    });
    expect(extras.mounts).toContainEqual({ kind: "rw", path: `${HOME}/.claude` });
    expect(extras.ensureDirs).toContain(`${HOME}/.claude/projects`);
  });
});

describe("topLevelLinkTargets", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists where the home's own links point (dangling ones skipped)", () => {
    const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "sbx-links-")));
    dirs.push(root);
    fs.mkdirSync(nodePath.join(root, "shared"));
    fs.writeFileSync(nodePath.join(root, "shared", "auth.json"), "{}");
    fs.mkdirSync(nodePath.join(root, "home"));
    fs.symlinkSync(
      nodePath.join(root, "shared", "auth.json"),
      nodePath.join(root, "home", "auth.json"),
    );
    fs.symlinkSync(nodePath.join(root, "missing"), nodePath.join(root, "home", "gone"));
    fs.writeFileSync(nodePath.join(root, "home", "config.toml"), "");
    expect(topLevelLinkTargets(nodePath.join(root, "home"))).toEqual([
      nodePath.join(root, "shared", "auth.json"),
    ]);
    expect(topLevelLinkTargets(nodePath.join(root, "nope"))).toEqual([]);
  });
});
