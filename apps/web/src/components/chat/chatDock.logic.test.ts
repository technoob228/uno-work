import { describe, expect, it } from "vitest";

import { chatDockFirstLine, chatDockStatus, nextChatDockNotice } from "./chatDock.logic";

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
  const reply = { id: "m2", text: "Merged.\nDetails", streaming: false };

  it("shows a new finished reply once", () => {
    expect(
      nextChatDockNotice({ pendingApproval: null, latestReply: reply, seenReplyId: "m1" }),
    ).toEqual({ kind: "reply", id: "m2", text: "Merged." });
    expect(
      nextChatDockNotice({ pendingApproval: null, latestReply: reply, seenReplyId: "m2" }),
    ).toBeNull();
  });

  it("waits while the reply is still streaming", () => {
    expect(
      nextChatDockNotice({
        pendingApproval: null,
        latestReply: { ...reply, streaming: true },
        seenReplyId: "m1",
      }),
    ).toBeNull();
  });

  it("always shows an approval the agent waits for", () => {
    expect(
      nextChatDockNotice({
        pendingApproval: { requestId: "r1", detail: "./release.sh promote" },
        latestReply: reply,
        seenReplyId: "m2",
      }),
    ).toEqual({ kind: "approval", id: "r1", text: "./release.sh promote" });
  });
});
