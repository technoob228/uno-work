import { describe, expect, it } from "vitest";

import {
  chatDockApprovalPhrase,
  chatDockFirstLine,
  chatDockInitialSeenReplyId,
  chatDockInsetPx,
  chatDockLatestReply,
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

describe("chatDockInitialSeenReplyId", () => {
  it("counts the reply on screen as seen when the chat folds", () => {
    expect(
      chatDockInitialSeenReplyId([
        { id: "m1", role: "user", streaming: false },
        { id: "m2", role: "assistant", streaming: false },
        { id: "m3", role: "user", streaming: false },
      ]),
    ).toBe("m2");
    expect(chatDockInitialSeenReplyId([{ id: "m1", role: "user", streaming: false }])).toBeNull();
  });

  it("does not count a reply still being written", () => {
    expect(
      chatDockInitialSeenReplyId([
        { id: "m1", role: "assistant", streaming: false },
        { id: "m2", role: "user", streaming: false },
        { id: "m3", role: "assistant", streaming: true },
      ]),
    ).toBe("m1");
  });
});

type Msg = { id: string; role: string; text: string; streaming: boolean };
const user = (id: string): Msg => ({ id, role: "user", text: "do it", streaming: false });
const reply = (id: string, streaming = false): Msg => ({
  id,
  role: "assistant",
  text: `reply ${id}`,
  streaming,
});

/**
 * The mini window's rule (ChatMiniWindow `useDockNotice`), step by step: the
 * seen reply starts at what was on screen, and a shown hint marks its reply
 * seen — so a hint pops up once per new reply, never for an old one.
 */
describe("when the mini window shows a hint", () => {
  function run(
    steps: ReadonlyArray<{ messages: Msg[]; isWorking: boolean }>,
    initial: Msg[],
  ): Array<string | null> {
    let seen = chatDockInitialSeenReplyId(initial);
    return steps.map(({ messages, isWorking }) => {
      const notice = nextChatDockNotice({
        pendingApproval: null,
        messages,
        isWorking,
        seenReplyId: seen,
      });
      if (notice)
        seen = notice.kind === "reply" ? notice.id : (chatDockLatestReply(messages)?.id ?? null);
      return notice ? notice.id : null;
    });
  }
  it("an old reply never pops up on fold or on re-renders", () => {
    const onScreen = [user("u1"), reply("a1")];
    expect(
      run(
        [
          { messages: onScreen, isWorking: false },
          { messages: [...onScreen], isWorking: false },
        ],
        onScreen,
      ),
    ).toEqual([null, null]);
  });

  it("a new turn: quiet while working, one hint when the turn is handed back", () => {
    const start = [user("u1"), reply("a1")];
    const turn = [...start, user("u2"), reply("a2")];
    const done = [...turn, reply("a3")];
    expect(
      run(
        [
          { messages: [...start, user("u2")], isWorking: true },
          { messages: turn, isWorking: true },
          { messages: done, isWorking: false },
          { messages: [...done], isWorking: false },
        ],
        start,
      ),
    ).toEqual([null, null, "a3", null]);
  });

  it("folded while the reply was being written: it pops up once it's done", () => {
    const writing = [user("u1"), reply("a1", true)];
    const finished = [user("u1"), reply("a1")];
    expect(
      run(
        [
          { messages: writing, isWorking: true },
          { messages: finished, isWorking: false },
          { messages: finished, isWorking: false },
        ],
        writing,
      ),
    ).toEqual([null, "a1", null]);
  });
});

describe("chatDockInsetPx — room the full-screen tab leaves for the dock (P1, 28.10)", () => {
  it("is the dock's height from its top edge to the window bottom, plus a hair", () => {
    expect(chatDockInsetPx({ mode: "peek", viewportHeight: 926, dockTop: 840 })).toBe(94);
  });

  it("is nothing while the chat is folded away — the tab goes all the way down", () => {
    expect(chatDockInsetPx({ mode: "minimized", viewportHeight: 926, dockTop: 840 })).toBeNull();
  });

  it("is nothing without a dock on screen", () => {
    expect(chatDockInsetPx({ mode: "peek", viewportHeight: 926, dockTop: null })).toBeNull();
    expect(chatDockInsetPx({ mode: "peek", viewportHeight: 926, dockTop: 2000 })).toBeNull();
  });
});
