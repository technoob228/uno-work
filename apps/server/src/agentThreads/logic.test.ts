import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  agentMessageEnvelope,
  checkMessageText,
  clampInteger,
  defaultTitleFromText,
  deriveAgentThreadStatus,
  isCwdInsideOwnProject,
  lastAssistantText,
  messageAuthor,
  parseListScope,
  resolveProviderModelSelection,
  threadRelation,
} from "./logic.ts";

const CALLER = "thread-parent" as ThreadId;

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models?: ReadonlyArray<string>;
  readonly installed?: boolean;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  enabled: true,
  installed: input.installed ?? true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: (input.models ?? []).map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

type StatusShell = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn" | "latestUserMessageAt"
>;

const statusShell = (overrides: Partial<StatusShell> = {}): StatusShell =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    ...overrides,
  }) as StatusShell;

const session = (status: string, updatedAt = "2026-09-14T10:00:10.000Z") =>
  ({
    threadId: "t",
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt,
  }) as unknown as NonNullable<StatusShell["session"]>;

describe("deriveAgentThreadStatus", () => {
  it("is waiting while an approval or user input is pending", () => {
    expect(
      deriveAgentThreadStatus(
        statusShell({ hasPendingApprovals: true, session: session("running") }),
      ),
    ).toBe("waiting");
    expect(deriveAgentThreadStatus(statusShell({ hasPendingUserInput: true }))).toBe("waiting");
  });

  it("is running while the session runs", () => {
    expect(deriveAgentThreadStatus(statusShell({ session: session("running") }))).toBe("running");
    expect(deriveAgentThreadStatus(statusShell({ session: session("starting") }))).toBe("running");
  });

  it("is running right after a send, before the session reacted", () => {
    expect(
      deriveAgentThreadStatus(
        statusShell({
          latestUserMessageAt: "2026-09-14T10:00:20.000Z",
          session: session("ready", "2026-09-14T10:00:10.000Z"),
        }),
      ),
    ).toBe("running");
    expect(
      deriveAgentThreadStatus(statusShell({ latestUserMessageAt: "2026-09-14T10:00:20.000Z" })),
    ).toBe("running");
  });

  it("is error when the session failed after the last message", () => {
    expect(
      deriveAgentThreadStatus(
        statusShell({
          latestUserMessageAt: "2026-09-14T10:00:00.000Z",
          session: session("error", "2026-09-14T10:00:05.000Z"),
        }),
      ),
    ).toBe("error");
  });

  it("is idle once the session is ready after the last message", () => {
    expect(
      deriveAgentThreadStatus(
        statusShell({
          latestUserMessageAt: "2026-09-14T10:00:00.000Z",
          session: session("ready", "2026-09-14T10:00:30.000Z"),
        }),
      ),
    ).toBe("idle");
  });
});

describe("messageAuthor", () => {
  it("maps senders to you / human / role", () => {
    expect(messageAuthor({ role: "user", sentByThreadId: CALLER }, CALLER)).toBe("you");
    expect(messageAuthor({ role: "user" }, CALLER)).toBe("human");
    expect(messageAuthor({ role: "user", sentByThreadId: null }, CALLER)).toBe("human");
    expect(messageAuthor({ role: "user", sentByThreadId: "other" as ThreadId }, CALLER)).toBe(
      "agent",
    );
    expect(messageAuthor({ role: "assistant" }, CALLER)).toBe("assistant");
    expect(messageAuthor({ role: "system" }, CALLER)).toBe("system");
  });
});

describe("resolveProviderModelSelection", () => {
  const providers = [
    provider({ instanceId: "codex", driver: "codex", models: ["gpt-5.4", "gpt-5.3-codex"] }),
    provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
    }),
    provider({ instanceId: "codex_work", driver: "codex", models: ["gpt-5.4"] }),
    provider({ instanceId: "cursor", driver: "cursor", installed: false }),
  ];

  it("accepts a driver kind and picks the driver's default model", () => {
    expect(
      resolveProviderModelSelection({ provider: "claudeAgent", model: undefined, providers }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
    });
  });

  it("accepts an instance id and an aliased model", () => {
    expect(
      resolveProviderModelSelection({ provider: "codex_work", model: "5.3", providers }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "codex_work", model: "gpt-5.3-codex" },
    });
  });

  it("understands `claude` as the Claude driver", () => {
    const resolved = resolveProviderModelSelection({
      provider: "claude",
      model: undefined,
      providers,
    });
    expect(resolved.ok && resolved.selection.instanceId).toBe("claudeAgent");
  });

  it("rejects unknown and not-installed providers with a helpful message", () => {
    const unknown = resolveProviderModelSelection({
      provider: "gemini",
      model: undefined,
      providers,
    });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain("codex");
    const notInstalled = resolveProviderModelSelection({
      provider: "cursor",
      model: undefined,
      providers,
    });
    expect(notInstalled.ok).toBe(false);
  });
});

describe("small helpers", () => {
  it("validates text", () => {
    expect(checkMessageText("  hi ")).toEqual({ ok: true, value: "hi" });
    expect(checkMessageText("   ").ok).toBe(false);
    expect(checkMessageText(42).ok).toBe(false);
    expect(checkMessageText("x".repeat(32_001)).ok).toBe(false);
  });

  it("derives a single-line title of ~60 chars", () => {
    expect(defaultTitleFromText("Fix\nthe   build")).toBe("Fix the build");
    const long = defaultTitleFromText("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("clamps query integers", () => {
    expect(clampInteger(null, { fallback: 20, min: 1, max: 100 })).toBe(20);
    expect(clampInteger("500", { fallback: 20, min: 1, max: 100 })).toBe(100);
    expect(clampInteger("abc", { fallback: 20, min: 1, max: 100 })).toBe(20);
    expect(clampInteger("-5", { fallback: 0, min: 0, max: 600_000 })).toBe(0);
  });

  it("recognizes cwd inside the caller's project or worktree", () => {
    const base = { workspaceRoot: "/p/app", worktreePath: "/wt/app-1" };
    expect(isCwdInsideOwnProject({ ...base, cwd: "/p/app/" })).toBe(true);
    expect(isCwdInsideOwnProject({ ...base, cwd: "/p/app/src" })).toBe(true);
    expect(isCwdInsideOwnProject({ ...base, cwd: "/wt/app-1" })).toBe(true);
    expect(isCwdInsideOwnProject({ ...base, cwd: "/p/application" })).toBe(false);
  });

  it("returns the last non-empty assistant text capped at 500", () => {
    expect(
      lastAssistantText([
        { role: "assistant", text: "first" },
        { role: "assistant", text: "y".repeat(900) },
        { role: "user", text: "later" },
        { role: "assistant", text: "  " },
      ]),
    ).toBe("y".repeat(500));
    expect(lastAssistantText([{ role: "user", text: "hi" }])).toBeNull();
  });
});

describe("agentMessageEnvelope", () => {
  const sender = {
    id: "thread-boss" as ThreadId,
    title: "Boss",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  } as Parameters<typeof agentMessageEnvelope>[0]["sender"];

  it("tells a peer how to write back", () => {
    const text = agentMessageEnvelope({
      sender,
      senderThreadId: "thread-boss" as ThreadId,
      recipientSpawnedByThreadId: null,
      text: "review this",
    });
    expect(text).toContain("«Boss» (threadId thread-boss, codex)");
    expect(text).toContain("POST $UNO_WORK_BRIDGE_URL/api/threads/thread-boss/messages");
    expect(text.endsWith("\n\nreview this")).toBe(true);
  });

  it("tells a child its parent reads the answer in place", () => {
    const text = agentMessageEnvelope({
      sender,
      senderThreadId: "thread-boss" as ThreadId,
      recipientSpawnedByThreadId: "thread-boss" as ThreadId,
      text: "next",
    });
    expect(text).toContain("просто ответь здесь");
    expect(text).not.toContain("/messages");
  });

  it("survives a deleted sender", () => {
    const text = agentMessageEnvelope({
      sender: null,
      senderThreadId: "thread-gone" as ThreadId,
      recipientSpawnedByThreadId: undefined,
      text: "hi",
    });
    expect(text).toContain("«без названия» (threadId thread-gone)");
  });
});

describe("threadRelation / parseListScope", () => {
  it("classifies threads relative to the caller", () => {
    const caller = { id: "c" as ThreadId, spawnedByThreadId: "p" as ThreadId };
    expect(threadRelation(caller, { id: "c" as ThreadId })).toBe("self");
    expect(threadRelation(caller, { id: "p" as ThreadId })).toBe("parent");
    expect(
      threadRelation(caller, { id: "k" as ThreadId, spawnedByThreadId: "c" as ThreadId }),
    ).toBe("child");
    expect(threadRelation(caller, { id: "x" as ThreadId, spawnedByThreadId: null })).toBe("peer");
  });

  it("defaults to children and rejects unknown scopes", () => {
    expect(parseListScope(null)).toBe("children");
    expect(parseListScope(" project ")).toBe("project");
    expect(parseListScope("all")).toBe("all");
    expect(parseListScope("everyone")).toBeNull();
  });
});
