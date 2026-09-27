import { describe, expect, it } from "vitest";

import {
  classifySlackSender,
  classifyTelegramSender,
  runtimeModeForSender,
  telegramOwnerUserIds,
  withOwnerUserId,
} from "./connectorSenders.ts";

const group = { id: -100123, type: "supergroup" };

describe("classifyTelegramSender", () => {
  it("treats the person in a private chat as the owner", () => {
    expect(
      classifyTelegramSender({
        chat: { id: 42, type: "private" },
        from: { id: 42 },
        allowedChatIds: ["42"],
      }),
    ).toBe("owner");
  });

  it("obeys the owner in a group and ignores other members by default", () => {
    const base = { chat: group, allowedChatIds: ["42", "-100123"] };
    expect(classifyTelegramSender({ ...base, from: { id: 42 } })).toBe("owner");
    expect(classifyTelegramSender({ ...base, from: { id: 7 } })).toBe("ignore");
  });

  it("uses recorded owner ids even without an allowlisted private chat", () => {
    expect(
      classifyTelegramSender({
        chat: group,
        from: { id: 42 },
        allowedChatIds: ["-100123"],
        ownerUserIds: ["42"],
      }),
    ).toBe("owner");
    expect(
      classifyTelegramSender({ chat: group, from: { id: 42 }, allowedChatIds: ["-100123"] }),
    ).toBe("ignore");
  });

  it("lets other members in as approval-only members when the owner opted in", () => {
    expect(
      classifyTelegramSender({
        chat: group,
        from: { id: 7 },
        allowedChatIds: ["-100123"],
        groupMembers: "anyone-with-approval",
      }),
    ).toBe("member");
  });

  it("ignores bots and senderless posts", () => {
    const base = {
      chat: group,
      allowedChatIds: ["42"],
      groupMembers: "anyone-with-approval" as const,
    };
    expect(classifyTelegramSender({ ...base, from: { id: 42, is_bot: true } })).toBe("ignore");
    expect(classifyTelegramSender({ ...base, from: undefined })).toBe("ignore");
  });
});

describe("classifySlackSender", () => {
  it("treats DMs as the owner and channels as owner-only", () => {
    expect(classifySlackSender({ userId: "U1", senderIsBot: false, isDirectMessage: true })).toBe(
      "owner",
    );
    expect(
      classifySlackSender({
        userId: "U1",
        senderIsBot: false,
        isDirectMessage: false,
        ownerUserIds: ["U1"],
      }),
    ).toBe("owner");
    expect(
      classifySlackSender({
        userId: "U2",
        senderIsBot: false,
        isDirectMessage: false,
        ownerUserIds: ["U1"],
      }),
    ).toBe("ignore");
    expect(classifySlackSender({ userId: "U1", senderIsBot: true, isDirectMessage: true })).toBe(
      "ignore",
    );
  });
});

describe("helpers", () => {
  it("never widens the mode for members", () => {
    expect(runtimeModeForSender("owner", "full-access")).toBe("full-access");
    expect(runtimeModeForSender("member", "full-access")).toBe("approval-required");
  });

  it("derives owners from private chat ids", () => {
    expect([...telegramOwnerUserIds({ allowedChatIds: ["42", "-100123"] })]).toEqual(["42"]);
  });

  it("adds an owner id once", () => {
    const once = withOwnerUserId(undefined, "42");
    expect(once).toEqual(["42"]);
    expect(withOwnerUserId(once, "42")).toBe(once);
  });
});
