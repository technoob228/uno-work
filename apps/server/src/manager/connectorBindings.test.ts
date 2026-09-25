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
  isPrivateTelegramChat,
  isPrivateTelegramChatId,
  matchByTitleOrId,
  planPrivateChatMigration,
  resolveChatTarget,
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

describe("decideThreadRouting: the assistant's chats run on the Uno chat's engine (0.0.84)", () => {
  const target = { kind: "assistant" as const, projectId: assistantId };
  const hermes = (provider: string, model = "~x-ai/grok-latest") => ({
    instanceId: ProviderInstanceId.make("hermes"),
    model,
    options: [{ id: "llmProvider", value: provider }],
  });

  it("starts on Hermes ahead of the connector's own harness pick", () => {
    const routing = decideThreadRouting({
      target,
      mappedThread: shell({ projectId: assistantId, modelSelection: claude }),
      targetThread: null,
      connectorModelSelection: claude,
      assistantModelSelection: hermes("uno"),
      projectModelSelection: uno,
      inheritedModes: null,
    });
    expect(routing).toMatchObject({
      kind: "create",
      modelSelection: hermes("uno"),
      previousThreadId: threadId,
    });
  });

  it("reuses the thread on the same engine and starts fresh on a provider switch", () => {
    const base = {
      target,
      targetThread: null,
      connectorModelSelection: null,
      projectModelSelection: null,
      inheritedModes: null,
    };
    expect(
      decideThreadRouting({
        ...base,
        mappedThread: shell({ projectId: assistantId, modelSelection: hermes("uno") }),
        assistantModelSelection: hermes("uno"),
      }).kind,
    ).toBe("reuse");
    expect(
      decideThreadRouting({
        ...base,
        mappedThread: shell({ projectId: assistantId, modelSelection: hermes("uno") }),
        assistantModelSelection: hermes("xai"),
      }).kind,
    ).toBe("create");
  });
});

describe("personal Telegram chats talk to the main conversation (0.0.86)", () => {
  const mainThreadId = ThreadId.make("thread-main");
  const otherAssistant = ProjectId.make("assistant-work");

  it("detects private chats by type, falling back to a positive id", () => {
    expect(isPrivateTelegramChat({ id: 42, type: "private" })).toBe(true);
    expect(isPrivateTelegramChat({ id: -100123, type: "supergroup" })).toBe(false);
    expect(isPrivateTelegramChat({ id: -42, type: "group" })).toBe(false);
    expect(isPrivateTelegramChat({ id: 42 })).toBe(true);
    expect(isPrivateTelegramChat({ id: -42 })).toBe(false);
    expect(isPrivateTelegramChat(undefined)).toBe(false);
    expect(isPrivateTelegramChatId("123456")).toBe(true);
    expect(isPrivateTelegramChatId("-1001234")).toBe(false);
    expect(isPrivateTelegramChatId("0")).toBe(false);
    expect(isPrivateTelegramChatId("abc")).toBe(false);
  });

  it("routes an unbound or assistant-bound private chat to the main conversation", () => {
    for (const current of [
      null,
      binding({ target: { kind: "assistant", projectId: assistantId } }),
    ]) {
      expect(
        resolveChatTarget({
          connectorProjectId: assistantId,
          binding: current,
          isPrivateChat: true,
          mainThreadId,
        }),
      ).toEqual({ kind: "thread", threadId: mainThreadId });
    }
  });

  it("keeps a group on its own thread (the assistant target)", () => {
    expect(
      resolveChatTarget({
        connectorProjectId: assistantId,
        binding: null,
        isPrivateChat: false,
        mainThreadId,
      }),
    ).toEqual({ kind: "assistant", projectId: assistantId });
  });

  it("keeps explicit /use and /thread choices, other assistants' bots, and works without a main conversation", () => {
    const toProject = binding({ target: { kind: "project", projectId } });
    const toThread = binding({ target: { kind: "thread", threadId } });
    for (const current of [toProject, toThread]) {
      expect(
        resolveChatTarget({
          connectorProjectId: assistantId,
          binding: current,
          isPrivateChat: true,
          mainThreadId,
        }),
      ).toEqual(current.target);
    }
    expect(
      resolveChatTarget({
        connectorProjectId: otherAssistant,
        binding: null,
        isPrivateChat: true,
        mainThreadId,
      }),
    ).toEqual({ kind: "assistant", projectId: otherAssistant });
    expect(
      resolveChatTarget({
        connectorProjectId: assistantId,
        binding: null,
        isPrivateChat: true,
        mainThreadId: null,
      }),
    ).toEqual({ kind: "assistant", projectId: assistantId });
  });

  it("plans the migration for private chats only, keeping notify flags and explicit bindings", () => {
    const plan = planPrivateChatMigration({
      connectorProjectId: assistantId,
      allowedChatIds: ["111", "-100222", "333", "444", "555", "111"],
      bindings: [
        binding({
          chatId: "333",
          target: { kind: "assistant", projectId: assistantId },
          notifyOnComplete: true,
        }),
        binding({ chatId: "444", target: { kind: "project", projectId } }),
        binding({ chatId: "555", target: { kind: "thread", threadId: mainThreadId } }),
      ],
      mainThreadId,
    });
    expect(plan).toEqual([
      { chatId: "111", previousTarget: null, notifyOnComplete: false },
      {
        chatId: "333",
        previousTarget: { kind: "assistant", projectId: assistantId },
        notifyOnComplete: true,
      },
    ]);
    expect(
      planPrivateChatMigration({
        connectorProjectId: otherAssistant,
        allowedChatIds: ["111"],
        bindings: [],
        mainThreadId,
      }),
    ).toEqual([]);
  });

  it("keeps a chat bound to the main conversation in the assistant notify fallback", () => {
    const chats = resolveNotifyChats({
      bindings: [binding({ chatId: "111", target: { kind: "thread", threadId: mainThreadId } })],
      connectors: [
        { kind: "telegram", projectId: assistantId, allowedChatIds: ["111", "-100222"] },
      ],
      threadId: null,
      projectId: null,
      includeAssistantFallback: true,
      mainConversationThreadId: mainThreadId,
    });
    expect(chats.map((chat) => [chat.chatId, chat.via])).toEqual([
      ["111", "assistant"],
      ["-100222", "assistant"],
    ]);
  });
});
