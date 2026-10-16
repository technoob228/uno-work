import { describe, expect, it } from "vitest";

import {
  chatDockApprovalPhrase,
  chatDockFirstLine,
  chatDockStatus,
  chatDockStepPreview,
  nextChatDockNotice,
} from "./chatDock.logic";

describe("chatDockStatus", () => {
  it("puts a question to the person before working", () => {
    expect(
      chatDockStatus({ isWorking: true, hasPendingApproval: true, hasPendingUserInput: false }),
    ).toBe("needs-approval");
    expect(
      chatDockStatus({ isWorking: true, hasPendingApproval: false, hasPendingUserInput: true }),
    ).toBe("needs-answer");
    expect(
      chatDockStatus({ isWorking: true, hasPendingApproval: false, hasPendingUserInput: false }),
    ).toBe("working");
    expect(
      chatDockStatus({ isWorking: false, hasPendingApproval: false, hasPendingUserInput: false }),
    ).toBe("your-turn");
  });
});

describe("chatDockFirstLine", () => {
  it("takes the first non-empty line without markdown marks", () => {
    expect(chatDockFirstLine("\n\n## **Done:** tests `green`\nmore")).toBe("Done: tests green");
    expect(chatDockFirstLine("- first item\n- second")).toBe("first item");
  });

  it("cuts long lines with an ellipsis", () => {
    const line = chatDockFirstLine("word ".repeat(80), 20);
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("nextChatDockNotice", () => {
  const messages = [
    { id: "m1", role: "user", text: "Ship it", streaming: false },
    { id: "m2", role: "assistant", text: "Merged.\nDetails", streaming: false },
  ];

  it("shows the reply once the agent hands the turn back, once", () => {
    const input = { pendingApproval: null, messages, isWorking: false };
    expect(nextChatDockNotice({ ...input, seenReplyId: "m0" })).toEqual({
      kind: "reply",
      id: "m2",
      text: "Merged.",
    });
    expect(nextChatDockNotice({ ...input, seenReplyId: "m2" })).toBeNull();
  });

  it("stays quiet in the middle of a turn and while a reply streams", () => {
    expect(
      nextChatDockNotice({ pendingApproval: null, messages, isWorking: true, seenReplyId: "m0" }),
    ).toBeNull();
    expect(
      nextChatDockNotice({
        pendingApproval: null,
        messages: [{ ...messages[1]!, streaming: true }],
        isWorking: false,
        seenReplyId: "m0",
      }),
    ).toBeNull();
  });

  it("always shows an approval: the agent's words first, the command whole", () => {
    const command = "./release.sh promote train/1010 --to prod --with-a-very-long-flag";
    expect(
      nextChatDockNotice({
        pendingApproval: { requestId: "r1", requestKind: "command", detail: command },
        messages,
        isWorking: true,
        seenReplyId: "m2",
      }),
    ).toEqual({ kind: "approval", id: "r1", text: "Merged.", command });
  });
});

describe("chatDockApprovalPhrase", () => {
  it("falls back to a plain phrase when the agent said nothing since the person", () => {
    expect(
      chatDockApprovalPhrase({
        requestKind: "file-change",
        messages: [
          { role: "assistant", text: "old" },
          { role: "user", text: "go" },
        ],
      }),
    ).toBe("The agent wants to change files.");
  });
});

describe("chatDockStepPreview", () => {
  it("keeps the step short", () => {
    expect(chatDockStepPreview("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
