import { describe, expect, it } from "vitest";

import {
  type AssistantChatCandidate,
  findMarkedAssistantChat,
  pickAssistantChatToMigrate,
  resolveAssistantChat,
} from "./assistantChat.ts";

const HOME = "assistant-home";

function chat(overrides: Partial<AssistantChatCandidate> & { id: string }): AssistantChatCandidate {
  return {
    projectId: HOME,
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("findMarkedAssistantChat", () => {
  it("returns the live chat marked as the assistant chat", () => {
    const threads = [chat({ id: "a" }), chat({ id: "b", assistantRole: "chat" })];
    expect(findMarkedAssistantChat(threads)?.id).toBe("b");
  });

  it("ignores a deleted marked chat and spawned chats", () => {
    const threads = [
      chat({ id: "a", assistantRole: "chat", deletedAt: "2026-09-02T00:00:00.000Z" }),
      chat({ id: "b", assistantRole: "spawned" }),
    ];
    expect(findMarkedAssistantChat(threads)).toBeNull();
  });
});

describe("pickAssistantChatToMigrate", () => {
  it("keeps the assistant chat the person used last", () => {
    const threads = [
      chat({ id: "old", latestUserMessageAt: "2026-09-10T00:00:00.000Z" }),
      chat({ id: "recent", latestUserMessageAt: "2026-09-20T00:00:00.000Z" }),
      chat({ id: "touched", updatedAt: "2026-09-15T00:00:00.000Z" }),
    ];
    expect(pickAssistantChatToMigrate(threads, { assistantProjectId: HOME })?.id).toBe("recent");
  });

  it("prefers an active chat over an archived one used later", () => {
    const threads = [
      chat({
        id: "archived",
        archivedAt: "2026-09-21T00:00:00.000Z",
        latestUserMessageAt: "2026-09-20T00:00:00.000Z",
      }),
      chat({ id: "active", latestUserMessageAt: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(pickAssistantChatToMigrate(threads, { assistantProjectId: HOME })?.id).toBe("active");
  });

  it("falls back to an archived chat so its history is not lost", () => {
    const threads = [chat({ id: "archived", archivedAt: "2026-09-21T00:00:00.000Z" })];
    expect(pickAssistantChatToMigrate(threads, { assistantProjectId: HOME })?.id).toBe("archived");
  });

  it("never picks a Telegram/Slack chat's thread, another project, a deleted or a spawned chat", () => {
    const threads = [
      chat({ id: "telegram", latestUserMessageAt: "2026-09-22T00:00:00.000Z" }),
      chat({ id: "project", projectId: "p1", latestUserMessageAt: "2026-09-22T00:00:00.000Z" }),
      chat({ id: "other-assistant", projectId: "assistant-sales" }),
      chat({ id: "deleted", deletedAt: "2026-09-22T00:00:00.000Z" }),
      chat({ id: "spawned", assistantRole: "spawned" }),
    ];
    expect(
      pickAssistantChatToMigrate(threads, {
        assistantProjectId: HOME,
        excludedThreadIds: new Set(["telegram"]),
      }),
    ).toBeNull();
  });

  it("is deterministic on ties", () => {
    const threads = [chat({ id: "b" }), chat({ id: "a" })];
    expect(pickAssistantChatToMigrate(threads, { assistantProjectId: HOME })?.id).toBe("a");
  });
});

describe("resolveAssistantChat", () => {
  const threads = [
    chat({ id: "legacy", latestUserMessageAt: "2026-09-20T00:00:00.000Z" }),
    chat({ id: "marked", assistantRole: "chat" }),
  ];

  it("uses the marked chat when there is one", () => {
    expect(
      resolveAssistantChat(threads, { assistantProjectId: HOME, daemonMarksChat: true })?.id,
    ).toBe("marked");
  });

  it("falls back to the migration pick on an older daemon", () => {
    expect(
      resolveAssistantChat([threads[0]!], { assistantProjectId: HOME, daemonMarksChat: false })?.id,
    ).toBe("legacy");
  });

  it("waits for the daemon's own mark on a new daemon", () => {
    expect(
      resolveAssistantChat([threads[0]!], { assistantProjectId: HOME, daemonMarksChat: true }),
    ).toBeNull();
  });
});
