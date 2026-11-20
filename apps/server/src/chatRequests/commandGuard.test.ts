import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { judgePath } from "../myComputer/trust/pathPolicy.ts";
import { claudeGuardHook, makeCommandGuard } from "./commandGuard.ts";

// The real tiers and the real resolver, run here with a made-up home.
let home: string;
let project: string;
let stateDir: string;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "guard-home-"));
  project = path.join(home, "projects", "bakery");
  stateDir = path.join(home, ".unowork", "userdata");
  mkdirSync(project, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const guard = () =>
  makeCommandGuard(
    {
      why: "started at the request of a cloud chat",
      blockedRoots: [stateDir, path.join(home, ".uno-work", "chat-requests")],
    },
    { home, os: "linux" },
  );

const check = (toolName: string, toolInput: unknown) =>
  guard().check({ toolName, toolInput, cwd: project });

describe("a chat started at a cloud chat's request", () => {
  it.each([
    ["ssh to another machine", "ssh root@prod.example.com 'systemctl restart app'"],
    ["a deploy", "vercel deploy --prod"],
    ["a push", "git push origin main"],
    ["sudo", "sudo rm -rf /var/www"],
    ["an install", "npm install -g some-cli"],
    ["reading keys", "cat ~/.ssh/id_ed25519"],
  ])("is refused %s", async (_what, command) => {
    const verdict = await check("Bash", { command });
    expect(verdict).not.toBeNull();
    expect(verdict!.deny).toMatch(/^Blocked here: /);
    expect(verdict!.deny).toContain("say what is needed and stop");
  });

  it.each([["ls -la"], ["git status"], ["npm run dev"], ["cat package.json"]])(
    "goes on with %s",
    async (command) => {
      expect(await check("Bash", { command })).toBeNull();
    },
  );

  it("reads and edits in its project, never keys or Uno Work's own data", async () => {
    expect(await check("Read", { file_path: path.join(project, "index.html") })).toBeNull();
    expect(await check("Edit", { file_path: path.join(project, "index.html") })).toBeNull();
    expect(await check("Read", { file_path: path.join(home, ".ssh", "id_rsa") })).not.toBeNull();
    expect(await check("Read", { file_path: path.join(stateDir, "settings.json") })).not.toBeNull();
    expect(await check("Bash", { command: `cat ${stateDir}/settings.json` })).not.toBeNull();
    expect(await check("Grep", { pattern: "x", path: home })).not.toBeNull();
    expect(await check("Write", { file_path: "/etc/hosts" })).not.toBeNull();
  });

  it("keeps uno-work, refuses the person's other MCP servers", async () => {
    expect(await check("mcp__uno-work__uno_guide", {})).toBeNull();
    expect(await check("mcp__github__create_pr", {})).not.toBeNull();
  });

  it("answers the SDK hook with a deny, and lets the rest through", async () => {
    const hook = claudeGuardHook(guard());
    const signal = new AbortController().signal;
    const denied = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push" },
        cwd: project,
      },
      "tool-1",
      { signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    const allowed = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: project,
      },
      "tool-2",
      { signal },
    );
    expect(allowed).toEqual({ continue: true });
  });

  it("refuses when the check itself fails", async () => {
    const broken = claudeGuardHook({ check: () => Promise.reject(new Error("boom")) });
    const verdict = await broken(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(verdict).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("the request folder on the person's computer", () => {
  it("is blocked for agents' own calls there", () => {
    const ctx = { home: "/Users/m", allowed: ["/Users/m/projects"], caseInsensitive: true };
    expect(judgePath("/Users/m/.uno-work/chat-requests/in/x.json", "write", ctx).tier).toBe(
      "blocked",
    );
    expect(judgePath("/Users/m/.uno-work/chat-requests/state.json", "read", ctx).tier).toBe(
      "blocked",
    );
    expect(judgePath("/Users/m/.uno-work/agent-browser/x", "read", ctx).tier).not.toBe("blocked");
  });
});

describe("T51: a chat answering a colleague's agent's question", () => {
  const readOnly = () =>
    makeCommandGuard(
      {
        why: "started at a colleague's request",
        blockedRoots: [stateDir],
        readOnly: true,
      },
      { home, os: "linux" },
    );
  const ask = (toolName: string, toolInput: unknown) =>
    readOnly().check({ toolName, toolInput, cwd: project });

  it("reads the project", async () => {
    expect(await ask("Read", { file_path: path.join(project, "index.html") })).toBeNull();
    expect(await ask("Grep", { pattern: "price", path: project })).toBeNull();
  });

  it.each([
    ["Bash", { command: "ls" }],
    ["Edit", { file_path: "index.html" }],
    ["Write", { file_path: "x" }],
    ["WebFetch", { url: "https://example.com" }],
    ["mcp__uno-work__mail_send", {}],
  ])("refuses %s", async (toolName, input) => {
    expect((await ask(toolName, input))?.deny).toContain("This chat only reads");
  });

  it("still never reads keys", async () => {
    expect(await ask("Read", { file_path: path.join(home, ".ssh", "id_ed25519") })).not.toBeNull();
  });
});
