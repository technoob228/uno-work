import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_SANDBOX_PROJECT_GONE_MESSAGE,
  ASSISTANT_SANDBOX_REQUIRED_MESSAGE,
  ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE,
  ASSISTANT_SANDBOX_UNSAFE_FOLDER_MESSAGE,
  assistantSandboxGrantDenial,
  decideAssistantSandbox,
  isUnsafeWritableDir,
  type SandboxDecisionInput,
} from "./assistantSandboxRules.ts";

const HOME = "/home/unowork";
const STATE = "/var/lib/uno-work/userdata";
const BASE = "/var/lib/uno-work";
const WORKTREES = `${BASE}/worktrees`;

const projects = [
  { id: "assistant-ana", workspaceRoot: `${HOME}/UnoWork/Assistants/ana` },
  { id: "assistant-bob", workspaceRoot: `${HOME}/UnoWork/Assistants/bob` },
  { id: "shop", workspaceRoot: `${HOME}/projects/shop` },
  { id: "shop-secrets", workspaceRoot: `${HOME}/projects/shop/secrets` },
  { id: "bank", workspaceRoot: `${HOME}/projects/bank` },
];

const allow = (...ids: string[]) => ids as unknown as ReadonlyArray<ProjectId>;

const input = (overrides: Partial<SandboxDecisionInput> = {}): SandboxDecisionInput => ({
  owner: { projectId: "assistant-ana", allowlist: allow("assistant-ana", "shop") },
  threadProjectId: "shop",
  cwd: `${HOME}/projects/shop`,
  projects,
  home: HOME,
  daemonDirs: [STATE, BASE],
  worktreesDir: WORKTREES,
  capability: { available: true, bwrapPath: "/usr/bin/bwrap", reason: null },
  tmpRoot: `${STATE}/sandbox/tmp`,
  ...overrides,
});

describe("decideAssistantSandbox", () => {
  it("leaves the person's own chats alone", () => {
    expect(decideAssistantSandbox(input({ owner: null }))).toEqual({ _tag: "none" });
  });

  it("leaves All-projects assistants alone, even where the sandbox can't run", () => {
    expect(
      decideAssistantSandbox(
        input({
          owner: { projectId: "assistant-ana", allowlist: "all" },
          capability: { available: false, bwrapPath: null, reason: "darwin" },
        }),
      ),
    ).toEqual({ _tag: "none" });
  });

  it("sandboxes a restricted assistant to its projects and its own folder", () => {
    expect(decideAssistantSandbox(input())).toEqual({
      _tag: "sandbox",
      plan: {
        bwrapPath: "/usr/bin/bwrap",
        home: HOME,
        cwd: `${HOME}/projects/shop`,
        writableDirs: [`${HOME}/UnoWork/Assistants/ana`, `${HOME}/projects/shop`],
        // Only what sits inside an allowed folder needs hiding: bob, bank are absent anyway.
        hiddenDirs: [`${HOME}/projects/shop/secrets`],
        tmpDir: `${STATE}/sandbox/tmp/assistant-ana`,
        assistantProjectId: "assistant-ana",
      },
    });
  });

  it("lets a chat's worktree in (it is the chat's own folder)", () => {
    const decision = decideAssistantSandbox(input({ cwd: `${WORKTREES}/shop/abc` }));
    expect(decision._tag).toBe("sandbox");
    if (decision._tag === "sandbox") {
      expect(decision.plan.writableDirs).toContain(`${WORKTREES}/shop/abc`);
      expect(decision.plan.cwd).toBe(`${WORKTREES}/shop/abc`);
    }
  });

  it("fails closed where the sandbox can't run (a Mac, no bwrap)", () => {
    expect(
      decideAssistantSandbox(
        input({ capability: { available: false, bwrapPath: null, reason: "no bwrap" } }),
      ),
    ).toEqual({ _tag: "refuse", message: ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE });
  });

  it("refuses a chat in a project the assistant may no longer use", () => {
    expect(decideAssistantSandbox(input({ threadProjectId: "bank" }))).toEqual({
      _tag: "refuse",
      message: ASSISTANT_SANDBOX_PROJECT_GONE_MESSAGE,
    });
  });

  it("refuses when an allowed project is the whole home or Uno Work's data", () => {
    const withHome = [...projects, { id: "everything", workspaceRoot: HOME }];
    expect(
      decideAssistantSandbox(
        input({
          projects: withHome,
          owner: { projectId: "assistant-ana", allowlist: allow("shop", "everything") },
        }),
      ),
    ).toEqual({ _tag: "refuse", message: ASSISTANT_SANDBOX_UNSAFE_FOLDER_MESSAGE });
    expect(decideAssistantSandbox(input({ cwd: `${STATE}/hermes-home-hermes` }))).toEqual({
      _tag: "refuse",
      message: ASSISTANT_SANDBOX_UNSAFE_FOLDER_MESSAGE,
    });
  });
});

describe("isUnsafeWritableDir", () => {
  const ctx = { home: HOME, daemonDirs: [STATE, BASE], worktreesDir: WORKTREES };
  it("flags the root, the home and its parents, the daemon's data", () => {
    for (const dir of ["/", "/home", HOME, BASE, STATE, `${STATE}/x`, "/var/lib"]) {
      expect(isUnsafeWritableDir(dir, ctx)).toBe(true);
    }
  });
  it("lets projects and worktrees through", () => {
    for (const dir of [`${HOME}/projects/shop`, `${WORKTREES}/shop/abc`, "/srv/site"]) {
      expect(isUnsafeWritableDir(dir, ctx)).toBe(false);
    }
  });
});

describe("assistantSandboxGrantDenial", () => {
  it("refuses Only selected projects where the sandbox can't run", () => {
    expect(assistantSandboxGrantDenial(["shop"], false)).toBe(ASSISTANT_SANDBOX_REQUIRED_MESSAGE);
    expect(ASSISTANT_SANDBOX_REQUIRED_MESSAGE).toContain(
      "Only selected projects needs its own computer or a cloud computer",
    );
  });
  it("allows All projects anywhere, and selected projects where it runs", () => {
    expect(assistantSandboxGrantDenial("all", false)).toBeNull();
    expect(assistantSandboxGrantDenial(["shop"], true)).toBeNull();
  });
});
