import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guardedTurnSandboxPolicy } from "../provider/Layers/CodexSessionRuntime.ts";
import { codexGuardRoots, makeCodexCommandGuard } from "./codexGuard.ts";
import { makeCommandGuard } from "./commandGuard.ts";

let home: string;
let project: string;
let stateDir: string;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "codex-guard-home-"));
  project = path.join(home, "projects", "bakery");
  stateDir = path.join(home, ".unowork", "userdata");
  for (const dir of [project, stateDir, path.join(home, ".ssh"), path.join(home, ".bun")]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const plan = () => ({
  why: "started at the request of a cloud chat",
  blockedRoots: [stateDir, path.join(home, ".uno-work", "chat-requests")],
});

const codexGuard = (runtimeMode: "full-access" | "auto-accept-edits" | "approval-required") =>
  makeCodexCommandGuard({
    plan: plan(),
    cwd: project,
    runtimeMode,
    home,
    guard: makeCommandGuard(plan(), { home, os: "linux" }),
  });

describe("a Codex chat started at a cloud chat's request", () => {
  it("reads the chat's folder, the projects and toolchains, never sign-ins or keys", () => {
    const roots = codexGuardRoots({ plan: plan(), cwd: project, home });
    expect(roots.readableRoots[0]).toBe(project);
    expect(roots.readableRoots).toContain(path.join(home, "projects"));
    expect(roots.readableRoots).toContain(path.join(home, ".bun"));
    for (const hidden of [".ssh", ".codex", ".claude", ".unowork", ".uno"]) {
      expect(roots.readableRoots).not.toContain(path.join(home, hidden));
    }
    expect(roots.readableRoots).not.toContain(home);
    expect(roots.writableRoots).toEqual([]);
  });

  it("skips folders that don't exist", () => {
    const roots = codexGuardRoots({ plan: plan(), cwd: project, home });
    expect(roots.readableRoots).not.toContain(path.join(home, ".cargo"));
  });

  it("runs without network in every mode", () => {
    const roots = codexGuardRoots({ plan: plan(), cwd: project, home });
    const write = guardedTurnSandboxPolicy("full-access", roots);
    expect(write).toMatchObject({
      type: "workspaceWrite",
      networkAccess: false,
      readOnlyAccess: { type: "restricted", includePlatformDefaults: true },
    });
    const read = guardedTurnSandboxPolicy("approval-required", roots);
    expect(read).toMatchObject({
      type: "readOnly",
      networkAccess: false,
      access: { type: "restricted" },
    });
  });

  it.each([
    ["ssh to another machine", "ssh root@prod.example.com uptime"],
    ["sudo", "sudo rm -rf /var/www"],
    ["reading keys", "cat ~/.ssh/id_ed25519"],
    ["a push hidden in a shell", "bash -lc 'git push && ssh box'"],
  ])("declines %s without a card", async (_what, command) => {
    expect(await codexGuard("full-access").check({ command, cwd: project })).toBe("decline");
  });

  it.each([
    ["a push", "git push origin main"],
    ["a global install", "npm install -g some-cli"],
    ["a push inside a shell", "/bin/zsh -lc 'git push'"],
  ])("asks the person for %s, in Full access too", async (_what, command) => {
    expect(await codexGuard("full-access").check({ command, cwd: project })).toBe("ask");
  });

  it("lets the rest out of the sandbox only in Full access", async () => {
    const command = "curl -s https://example.com";
    expect(await codexGuard("full-access").check({ command, cwd: project })).toBe("accept");
    expect(await codexGuard("auto-accept-edits").check({ command, cwd: project })).toBe("ask");
  });
});
