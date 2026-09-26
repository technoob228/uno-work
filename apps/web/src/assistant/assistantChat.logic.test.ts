import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../types";
import {
  ensureAssistantChatWhenReady,
  findAssistantChat,
  slackChannelState,
  telegramChannelState,
  isFromAssistant,
  isOlderAssistantChat,
  isRegularListChat,
} from "./assistantChat.logic";

function summary(
  overrides: Partial<Omit<SidebarThreadSummary, "id">> & { id: string },
): SidebarThreadSummary {
  return {
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project-1"),
    title: "Chat",
    interactionMode: "default",
    session: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    id: ThreadId.make(overrides.id),
  };
}

const HOME = ProjectId.make("assistant-home");

describe("findAssistantChat", () => {
  const legacy = summary({
    id: "legacy",
    projectId: HOME,
    latestUserMessageAt: "2026-09-20T00:00:00.000Z",
  });
  const marked = summary({ id: "marked", projectId: HOME, assistantRole: "chat" });

  it("uses the chat the daemon marked", () => {
    expect(findAssistantChat([legacy, marked], { daemonMarksChat: true })?.id).toBe("marked");
  });

  it("picks the last-used assistant chat on an older daemon", () => {
    expect(findAssistantChat([legacy], { daemonMarksChat: false })?.id).toBe("legacy");
  });
});

describe("chat list membership", () => {
  const uno = summary({ id: "uno", projectId: HOME, assistantRole: "chat" });
  const older = summary({ id: "older", projectId: HOME });
  const regular = summary({ id: "regular" });

  it("keeps the Uno chat and the assistant's older chats out of the main list", () => {
    expect(isRegularListChat(uno, "uno")).toBe(false);
    expect(isRegularListChat(older, "uno")).toBe(false);
    expect(isRegularListChat(regular, "uno")).toBe(true);
  });

  it("files the assistant's other chats under older Uno chats", () => {
    expect(isOlderAssistantChat(older, "uno")).toBe(true);
    expect(isOlderAssistantChat(uno, "uno")).toBe(false);
    expect(isOlderAssistantChat(regular, "uno")).toBe(false);
  });
});

describe("isFromAssistant", () => {
  it("labels chats Uno started, by role or by parent", () => {
    expect(isFromAssistant({ assistantRole: "spawned", spawnedByThreadId: null }, null)).toBe(true);
    expect(
      isFromAssistant({ assistantRole: null, spawnedByThreadId: ThreadId.make("uno") }, "uno"),
    ).toBe(true);
    expect(
      isFromAssistant({ assistantRole: null, spawnedByThreadId: ThreadId.make("other") }, "uno"),
    ).toBe(false);
  });
});

describe("channel states", () => {
  const telegram = {
    configured: true,
    enabled: true,
    health: null,
    lastError: null,
  } as const;

  it("reads Telegram as off, on or needing a look", () => {
    expect(telegramChannelState({ ...telegram, configured: false })).toBe("off");
    expect(telegramChannelState({ ...telegram, enabled: false })).toBe("off");
    expect(telegramChannelState(telegram)).toBe("on");
    expect(
      telegramChannelState({
        ...telegram,
        health: { status: "auth_expired", lastOkAt: null, lastError: "401", lastErrorAt: null },
      }),
    ).toBe("problem");
    // A bot no chat is linked to yet is not "on".
    expect(telegramChannelState({ ...telegram, allowedChatIds: [] })).toBe("problem");
    expect(telegramChannelState({ ...telegram, allowedChatIds: ["1"] })).toBe("on");
  });

  it("reads Slack from its last error", () => {
    expect(slackChannelState({ configured: false, enabled: false, lastError: null })).toBe("off");
    expect(slackChannelState({ configured: true, enabled: true, lastError: null })).toBe("on");
    expect(slackChannelState({ configured: true, enabled: true, lastError: "invalid_auth" })).toBe(
      "problem",
    );
  });
});

describe("ensureAssistantChatWhenReady", () => {
  it("keeps asking a computer that is still setting its assistant up", async () => {
    let clock = 0;
    let calls = 0;
    const result = await ensureAssistantChatWhenReady(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("The assistant is not set up on this computer yet.");
        return { threadId: "t-uno" };
      },
      {
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result).toEqual({ threadId: "t-uno" });
    expect(calls).toBe(3);
  });

  it("gives up after the wait: a real absence", async () => {
    let clock = 0;
    let calls = 0;
    const result = await ensureAssistantChatWhenReady(
      async () => {
        calls += 1;
        throw new Error("nope");
      },
      {
        waitMs: 5_000,
        retryMs: 1_000,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result).toBeNull();
    expect(calls).toBe(6);
  });
});
