import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ManagerConnectorBinding,
} from "@t3tools/contracts";

import {
  ASSISTANT_THREAD_RUNTIME_MODE,
  decideThreadRouting,
  effectiveBindingTarget,
  matchByTitleOrId,
  resolveNotifyChats,
  type RoutingThreadShell,
} from "./connectorBindings.ts";

const assistantId = ProjectId.make("assistant-home");
const projectId = ProjectId.make("project-api");
const threadId = ThreadId.make("thread-1");

const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-4-6" };
const uno = { instanceId: ProviderInstanceId.make("uno"), model: "uno/kimi" };

const shell = (overrides: Partial<RoutingThreadShell> = {}): RoutingThreadShell => ({
  id: threadId,
  projectId,
  archivedAt: null,
  modelSelection: claude,
  runtimeMode: "approval-required",
  interactionMode: "default",
  ...overrides,
});

const binding = (overrides: Partial<ManagerConnectorBinding>): ManagerConnectorBinding => ({
  kind: "telegram",
  chatId: "100",
  connectorProjectId: assistantId,
  target: { kind: "project", projectId },
  notifyOnComplete: false,
  updatedAt: "2026-09-11T00:00:00.000Z",
  ...overrides,
});

describe("effectiveBindingTarget", () => {
  it("defaults an unbound chat to the connector's assistant", () => {
    expect(effectiveBindingTarget(null, assistantId)).toEqual({
      kind: "assistant",
      projectId: assistantId,
    });
    expect(effectiveBindingTarget(binding({}), assistantId)).toEqual({
      kind: "project",
      projectId,
    });
  });
});

describe("decideThreadRouting", () => {
  describe("thread target", () => {
    const target = { kind: "thread" as const, threadId };

    it("reuses the exact thread with its own modes", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: null,
          targetThread: shell({ runtimeMode: "auto-accept-edits", interactionMode: "plan" }),
          connectorModelSelection: uno,
          projectModelSelection: null,
          inheritedModes: null,
        }),
      ).toEqual({
        kind: "reuse",
        threadId,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      });
    });

    it("rejects a missing or archived thread instead of creating one", () => {
      const missing = decideThreadRouting({
        target,
        mappedThread: null,
        targetThread: null,
        connectorModelSelection: null,
        projectModelSelection: null,
        inheritedModes: null,
      });
      expect(missing.kind).toBe("reject");
      expect(missing.kind === "reject" && missing.message).toContain("no longer exists");

      const archived = decideThreadRouting({
        target,
        mappedThread: null,
        targetThread: shell({ archivedAt: "2026-09-10T00:00:00.000Z" }),
        connectorModelSelection: null,
        projectModelSelection: null,
        inheritedModes: null,
      });
      expect(archived.kind).toBe("reject");
      expect(archived.kind === "reject" && archived.message).toContain("archived");
    });
  });

  describe("assistant target (today's flow)", () => {
    const target = { kind: "assistant" as const, projectId: assistantId };

    it("reuses the live per-chat thread in full access when the selection matches", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: shell({ projectId: assistantId, runtimeMode: "approval-required" }),
          targetThread: null,
          connectorModelSelection: claude,
          projectModelSelection: uno,
          inheritedModes: null,
        }),
      ).toEqual({
        kind: "reuse",
        threadId,
        runtimeMode: ASSISTANT_THREAD_RUNTIME_MODE,
        interactionMode: "default",
      });
    });

    it("lets the connector's harness choice override the project default and hands off on change", () => {
      const routing = decideThreadRouting({
        target,
        mappedThread: shell({ projectId: assistantId, modelSelection: claude }),
        targetThread: null,
        connectorModelSelection: uno,
        projectModelSelection: claude,
        inheritedModes: null,
      });
      expect(routing).toEqual({
        kind: "create",
        projectId: assistantId,
        modelSelection: uno,
        runtimeMode: "full-access",
        interactionMode: "default",
        previousThreadId: threadId,
      });
    });

    it("falls back to the assistant project's default model and rejects when none is set", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: null,
          targetThread: null,
          connectorModelSelection: null,
          projectModelSelection: claude,
          inheritedModes: null,
        }),
      ).toMatchObject({ kind: "create", modelSelection: claude, previousThreadId: null });
      expect(
        decideThreadRouting({
          target,
          mappedThread: null,
          targetThread: null,
          connectorModelSelection: null,
          projectModelSelection: null,
          inheritedModes: null,
        }),
      ).toEqual({ kind: "reject", message: "Assistant project has no model configured." });
    });
  });

  describe("project target", () => {
    const target = { kind: "project" as const, projectId };

    it("ignores the connector's harness choice and keeps the reused thread's own mode", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: shell({ modelSelection: claude, runtimeMode: "approval-required" }),
          targetThread: null,
          connectorModelSelection: uno,
          projectModelSelection: claude,
          inheritedModes: { runtimeMode: "full-access", interactionMode: "default" },
        }),
      ).toEqual({
        kind: "reuse",
        threadId,
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
    });

    it("creates on the project's default model with the inherited modes, never forcing full access", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: shell({ archivedAt: "2026-09-10T00:00:00.000Z" }),
          targetThread: null,
          connectorModelSelection: uno,
          projectModelSelection: claude,
          inheritedModes: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
        }),
      ).toEqual({
        kind: "create",
        projectId,
        modelSelection: claude,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        previousThreadId: threadId,
      });
      expect(
        decideThreadRouting({
          target,
          mappedThread: null,
          targetThread: null,
          connectorModelSelection: uno,
          projectModelSelection: claude,
          inheritedModes: null,
        }),
      ).toMatchObject({ kind: "create", runtimeMode: "approval-required" });
    });

    it("rejects a project without a default model", () => {
      expect(
        decideThreadRouting({
          target,
          mappedThread: null,
          targetThread: null,
          connectorModelSelection: uno,
          projectModelSelection: null,
          inheritedModes: null,
        }),
      ).toMatchObject({ kind: "reject" });
    });
  });
});

describe("matchByTitleOrId", () => {
  const items = [
    { id: "p-1", title: "Uno API" },
    { id: "p-2", title: "Uno Web" },
    { id: "p-3", title: "Antoha" },
    { id: "thread-abc", title: "Fix billing" },
  ];

  it("matches ids exactly, titles case-insensitively, then prefixes and substrings", () => {
    expect(matchByTitleOrId(items, "p-2")).toEqual({ kind: "match", item: items[1] });
    expect(matchByTitleOrId(items, "antoha")).toEqual({ kind: "match", item: items[2] });
    expect(matchByTitleOrId(items, "thread-a")).toEqual({ kind: "match", item: items[3] });
    expect(matchByTitleOrId(items, "fix")).toEqual({ kind: "match", item: items[3] });
    expect(matchByTitleOrId(items, "web")).toEqual({ kind: "match", item: items[1] });
  });

  it("reports ambiguity with the candidates and none for no hit or an empty query", () => {
    expect(matchByTitleOrId(items, "uno")).toEqual({
      kind: "ambiguous",
      candidates: [items[0], items[1]],
    });
    expect(matchByTitleOrId(items, "nothing")).toEqual({ kind: "none" });
    expect(matchByTitleOrId(items, "   ")).toEqual({ kind: "none" });
  });
});

describe("resolveNotifyChats", () => {
  const otherThread = ThreadId.make("thread-2");
  const bindings = [
    binding({ chatId: "100", target: { kind: "thread", threadId }, notifyOnComplete: true }),
    binding({ chatId: "200", target: { kind: "project", projectId } }),
    binding({ chatId: "300", target: { kind: "thread", threadId: otherThread } }),
    binding({ chatId: "400", target: { kind: "assistant", projectId: assistantId } }),
  ];
  const connectors = [
    { kind: "telegram" as const, projectId: assistantId, allowedChatIds: ["100", "400", "500"] },
  ];

  it("selects thread bindings and the thread's project bindings, deduplicated", () => {
    const chats = resolveNotifyChats({
      bindings: [...bindings, binding({ chatId: "100", target: { kind: "project", projectId } })],
      connectors,
      threadId,
      projectId,
      includeAssistantFallback: true,
    });
    expect(chats.map((chat) => [chat.chatId, chat.via, chat.notifyOnComplete])).toEqual([
      ["100", "thread", true],
      ["200", "project", false],
    ]);
  });

  it("without fallback returns nothing for an unbound thread", () => {
    expect(
      resolveNotifyChats({
        bindings,
        connectors,
        threadId: ThreadId.make("thread-unbound"),
        projectId: ProjectId.make("project-unbound"),
        includeAssistantFallback: false,
      }),
    ).toEqual([]);
  });

  it("falls back to the assistant's chats: explicit assistant bindings plus unbound allowed chats", () => {
    const chats = resolveNotifyChats({
      bindings,
      connectors,
      threadId: ThreadId.make("thread-unbound"),
      projectId: ProjectId.make("project-unbound"),
      includeAssistantFallback: true,
    });
    // 100 is bound elsewhere (to a thread) so it is not an assistant chat.
    expect(chats.map((chat) => [chat.chatId, chat.via])).toEqual([
      ["400", "assistant"],
      ["500", "assistant"],
    ]);
  });

  it("scopes the fallback to the assistant the subject lives in", () => {
    const otherAssistant = ProjectId.make("assistant-other");
    const chats = resolveNotifyChats({
      bindings: [
        ...bindings,
        binding({
          chatId: "900",
          connectorProjectId: otherAssistant,
          target: { kind: "assistant", projectId: otherAssistant },
        }),
      ],
      connectors: [
        ...connectors,
        { kind: "telegram", projectId: otherAssistant, allowedChatIds: ["900", "901"] },
      ],
      threadId: ThreadId.make("thread-in-other-assistant"),
      projectId: otherAssistant,
      includeAssistantFallback: true,
    });
    expect(chats.map((chat) => chat.chatId)).toEqual(["900", "901"]);
  });
});
