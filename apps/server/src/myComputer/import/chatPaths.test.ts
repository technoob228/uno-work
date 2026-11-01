import { describe, expect, it } from "vitest";

import {
  assertChatFilePath,
  claudeSessionId,
  codexSessionId,
  environmentProbe,
  isChatFilePath,
  parseEnvironmentProbe,
  resolveChatRoots,
} from "./chatPaths.ts";

const NOTHING = parseEnvironmentProbe("");
const SESSION = "11111111-2222-4333-8444-555555555555";

describe("resolveChatRoots", () => {
  it("uses the home folder on macOS and Linux", () => {
    expect(resolveChatRoots({ os: "posix", home: "/home/kate", env: NOTHING })).toEqual({
      os: "posix",
      claudeProjects: "/home/kate/.claude/projects",
      codexSessions: "/home/kate/.codex/sessions",
      codexIndex: "/home/kate/.codex/session_index.jsonl",
      openCodeDb: "/home/kate/.local/share/opencode/opencode.db",
    });
  });

  it("uses the home folder on Windows, with its separators", () => {
    const roots = resolveChatRoots({ os: "windows", home: "C:\\Users\\Kate", env: NOTHING });
    expect(roots.claudeProjects).toBe("C:\\Users\\Kate\\.claude\\projects");
    expect(roots.codexSessions).toBe("C:\\Users\\Kate\\.codex\\sessions");
    expect(roots.openCodeDb).toBe("C:\\Users\\Kate\\.local\\share\\opencode\\opencode.db");
  });

  it("follows CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_DATA_HOME", () => {
    const env = parseEnvironmentProbe(
      "claude=/data/claude/\ncodex=/data/codex\nxdg=/data/xdg\nsqlite3=/usr/bin/sqlite3\nopencode=",
    );
    expect(env.hasSqlite3).toBe(true);
    expect(env.hasOpenCode).toBe(false);
    const roots = resolveChatRoots({ os: "posix", home: "/home/kate", env });
    expect(roots.claudeProjects).toBe("/data/claude/projects");
    expect(roots.codexSessions).toBe("/data/codex/sessions");
    expect(roots.openCodeDb).toBe("/data/xdg/opencode/opencode.db");
  });
});

describe("the allow-list", () => {
  it("lets session files through", () => {
    expect(isChatFilePath(`/h/.claude/projects/-h-alpha/${SESSION}.jsonl`)).toBe(true);
    expect(isChatFilePath(`C:\\h\\.claude\\projects\\-h-alpha\\${SESSION}.jsonl`)).toBe(true);
    expect(
      isChatFilePath(
        `/h/.codex/sessions/2026/10/31/rollout-2026-10-31T13-47-53-${SESSION}.jsonl.zst`,
      ),
    ).toBe(true);
    expect(isChatFilePath("/h/.codex/session_index.jsonl")).toBe(true);
  });

  it.each([
    "/h/.claude/.credentials.json",
    "/h/.codex/auth.json",
    "/h/.local/share/opencode/auth.json",
    "/h/.local/share/opencode/opencode.db",
    "/h/.claude/projects/-h-alpha/.credentials.json",
    "/h/.claude/projects/-h-alpha/memory/note.md",
    `/h/.claude/projects/-h-alpha/${SESSION}/subagents/agent.jsonl`,
    `/h/.claude/projects/../.ssh/${SESSION}.jsonl`,
    "/etc/passwd",
    "/h/.codex/sessions/2026/10/31/auth.json",
  ])("refuses %s", (path) => {
    expect(isChatFilePath(path)).toBe(false);
    expect(() => assertChatFilePath(path)).toThrow(/not a chat session file/);
  });

  it("knows a session by its file name", () => {
    expect(claudeSessionId(`${SESSION}.jsonl`)).toBe(SESSION);
    expect(claudeSessionId("sessions-index.jsonl")).toBeNull();
    expect(codexSessionId(`rollout-2026-10-31T13-47-53-${SESSION}.jsonl`)).toBe(SESSION);
    expect(codexSessionId(`rollout-2026-10-31T13-47-53-${SESSION}.jsonl.zst`)).toBe(SESSION);
    expect(codexSessionId("auth.json")).toBeNull();
  });
});

describe("environmentProbe", () => {
  it("asks each shell in its own language", () => {
    expect(environmentProbe("posix")).toContain("CLAUDE_CONFIG_DIR");
    expect(environmentProbe("windows")).toContain("$env:CODEX_HOME");
    expect(environmentProbe("windows")).toContain("Get-Command sqlite3");
  });
});
