import { describe, expect, it } from "vitest";

import { deriveAgentTalkRuns, deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const agentTalkMessage = (
  id: string,
  second: number,
  role: "user" | "assistant",
  extra: { turnId?: string; sentByThreadId?: string } = {},
) => {
  const at = `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
  return {
    id: `${id}-entry`,
    kind: "message" as const,
    createdAt: at,
    message: {
      id: id as never,
      role,
      text: id,
      turnId: (extra.turnId ?? null) as never,
      createdAt: at,
      completedAt: at,
      streaming: false,
      sentByThreadId: (extra.sentByThreadId ?? null) as never,
    },
  };
};

describe("quiet agents: every run of agents' talk folds into one line (T63)", () => {
  const card = (id: string, second: number) => ({
    id: `html-render:${id}`,
    kind: "html-render" as const,
    createdAt: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`,
    htmlRender: { attachmentId: id, path: `/tmp/${id}.html`, title: id, height: 300 },
  });
  type Entry = ReturnType<typeof agentTalkMessage> | ReturnType<typeof card>;
  const rowsOf = (
    timelineEntries: ReadonlyArray<Entry>,
    extra: {
      expandedAgentRunIds?: ReadonlySet<string>;
      keepInSightEntryIds?: ReadonlySet<string>;
    } = {},
  ) =>
    deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
      ...extra,
    }).map((row) =>
      row.kind === "message"
        ? row.message.id
        : row.kind === "agent-talk-fold"
          ? `fold(${row.agentMessageCount}:${row.senderThreadIds.join("+")})`
          : row.kind === "html-render"
            ? `card:${row.htmlRender.attachmentId}`
            : row.kind,
    );

  it("folds the talk in the middle too, not only after the answer", () => {
    const entries = [
      agentTalkMessage("ask", 0, "user"),
      agentTalkMessage("answer", 2, "assistant", { turnId: "t1" }),
      agentTalkMessage("checks-1", 4, "user", { sentByThreadId: "checks" }),
      agentTalkMessage("reply-1", 6, "assistant", { turnId: "t2" }),
      agentTalkMessage("banners-1", 8, "user", { sentByThreadId: "banners" }),
      agentTalkMessage("reply-2", 10, "assistant", { turnId: "t3" }),
      agentTalkMessage("ask-2", 12, "user"),
      agentTalkMessage("answer-2", 14, "assistant", { turnId: "t4" }),
      agentTalkMessage("checks-2", 16, "user", { sentByThreadId: "checks" }),
      agentTalkMessage("reply-3", 18, "assistant", { turnId: "t5" }),
    ];
    expect(rowsOf(entries)).toEqual([
      "ask",
      "answer",
      "fold(2:checks+banners)",
      "ask-2",
      "answer-anchor",
      "answer-2",
      "fold(1:checks)",
    ]);
    const [firstRun] = deriveAgentTalkRuns(entries);
    expect(rowsOf(entries, { expandedAgentRunIds: new Set([firstRun!.id]) })).toEqual([
      "ask",
      "answer",
      "fold(2:checks+banners)",
      "checks-1",
      "reply-1",
      "banners-1",
      "reply-2",
      "ask-2",
      "answer-anchor",
      "answer-2",
      "fold(1:checks)",
    ]);
  });

  it("keeps a card and the sentence that introduces it in sight", () => {
    const entries = [
      agentTalkMessage("ask", 0, "user"),
      agentTalkMessage("answer", 2, "assistant", { turnId: "t1" }),
      agentTalkMessage("research-1", 4, "user", { sentByThreadId: "research" }),
      agentTalkMessage("reply-1", 6, "assistant", { turnId: "t2" }),
      agentTalkMessage("intro", 8, "assistant", { turnId: "t2" }),
      card("pricing", 9),
      agentTalkMessage("research-2", 10, "user", { sentByThreadId: "research" }),
      agentTalkMessage("reply-2", 12, "assistant", { turnId: "t3" }),
    ];
    expect(rowsOf(entries)).toEqual([
      "ask",
      "answer-anchor",
      "answer",
      "fold(1:research)",
      "intro",
      "card:pricing",
      "fold(1:research)",
    ]);
  });

  it("keeps the task an agent opened the chat with", () => {
    const entries = [
      agentTalkMessage("task", 0, "user", { sentByThreadId: "coordinator" }),
      agentTalkMessage("working-on-it", 2, "assistant", { turnId: "t1" }),
      agentTalkMessage("nudge", 4, "user", { sentByThreadId: "coordinator" }),
      agentTalkMessage("ok", 6, "assistant", { turnId: "t2" }),
    ];
    expect(rowsOf(entries)).toEqual(["task", "working-on-it", "fold(1:coordinator)"]);
  });

  it("keeps the answer to the person when an agent wrote before it", () => {
    const entries = [
      agentTalkMessage("ask", 0, "user"),
      agentTalkMessage("helper-1", 2, "user", { sentByThreadId: "helper" }),
      agentTalkMessage("answer", 4, "assistant", { turnId: "t1" }),
      agentTalkMessage("helper-2", 6, "user", { sentByThreadId: "helper" }),
      agentTalkMessage("reply", 8, "assistant", { turnId: "t2" }),
    ];
    expect(rowsOf(entries)).toEqual(["ask", "fold(1:helper)", "answer", "fold(1:helper)"]);
  });

  it("never folds away what waits for the person", () => {
    const entries = [
      agentTalkMessage("ask", 0, "user"),
      agentTalkMessage("answer", 2, "assistant", { turnId: "t1" }),
      agentTalkMessage("helper-1", 4, "user", { sentByThreadId: "helper" }),
      agentTalkMessage("site-link", 6, "assistant", { turnId: "t2" }),
      agentTalkMessage("helper-2", 8, "user", { sentByThreadId: "helper" }),
    ];
    expect(rowsOf(entries, { keepInSightEntryIds: new Set(["site-link-entry"]) })).toEqual([
      "ask",
      "answer-anchor",
      "answer",
      "fold(1:helper)",
      "site-link",
      "fold(1:helper)",
    ]);
  });

  it("keys a run by the message that opened it, so it stays open while it grows", () => {
    const entries = [
      agentTalkMessage("ask", 0, "user"),
      agentTalkMessage("answer", 2, "assistant", { turnId: "t1" }),
      agentTalkMessage("helper-1", 4, "user", { sentByThreadId: "helper" }),
    ];
    const grown = [...entries, agentTalkMessage("reply-1", 6, "assistant", { turnId: "t2" })];
    expect(deriveAgentTalkRuns(entries)[0]!.id).toBe(deriveAgentTalkRuns(grown)[0]!.id);
  });
});
