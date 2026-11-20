import type { ChatRequestView, ChatRequestsState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  JOURNAL_MAX,
  failureMessage,
  folderLabel,
  harnessLabel,
  journalEntries,
  journalTimeLabel,
  newlyWaiting,
  ownWaitingRequests,
  requestTitle,
  startsWithLine,
  statusChip,
  teamWaitingRequests,
  waitingCount,
  waitingRequests,
} from "./chatRequests.logic";

const NOW = Date.parse("2026-11-20T12:00:00Z");

function request(overrides: Partial<ChatRequestView> = {}): ChatRequestView {
  return {
    id: "a",
    status: "waiting",
    createdAt: "2026-11-20T11:55:00Z",
    expiresAt: "2026-11-20T13:55:00Z",
    decidedAt: null,
    from: {
      computerName: "uno-work",
      boxId: 395,
      threadId: "t-1",
      threadTitle: "Landing page for the bakery",
    },
    cwd: "~/projects/landing",
    provider: "claudeAgent",
    title: "Check the order form",
    gist: "Run the site locally and check the order form in Safari",
    brief: "Check it.",
    reason: null,
    threadId: null,
    threadState: null,
    ...overrides,
  };
}

function state(requests: ChatRequestView[]): ChatRequestsState {
  return { allow: true, limit: 2, active: 1, requests };
}

describe("chat requests from the cloud", () => {
  it("counts only what waits and hasn't run out", () => {
    const s = state([
      request({ id: "a" }),
      request({ id: "b", expiresAt: "2026-11-20T11:59:00Z" }),
      request({ id: "c", status: "started", threadId: "x" }),
    ]);
    expect(waitingRequests(s, NOW).map((q) => q.id)).toEqual(["a"]);
    expect(waitingCount(s, NOW)).toBe(1);
    expect(waitingCount(null, NOW)).toBe(0);
  });

  it("notifies once per new waiting request, not for what waited at start", () => {
    const first = state([request({ id: "a" })]);
    expect(newlyWaiting(null, first, NOW)).toEqual([]);
    const second = state([request({ id: "b" }), request({ id: "a" })]);
    expect(newlyWaiting(first, second, NOW).map((q) => q.id)).toEqual(["b"]);
    expect(newlyWaiting(second, second, NOW)).toEqual([]);
  });

  it("says who asks, where and with what", () => {
    expect(requestTitle(request())).toBe(
      "Landing page for the bakery on uno-work wants to start a chat here",
    );
    expect(folderLabel(null)).toBe("the project used last");
    expect(folderLabel("  ")).toBe("the project used last");
    expect(harnessLabel("claudeAgent")).toBe("Claude Code");
    expect(harnessLabel(null)).toBe("Claude Code");
    expect(startsWithLine(request({ cwd: null }))).toBe(
      "The chat starts in the project used last with Claude Code.",
    );
  });

  it("names every status for the journal", () => {
    expect(statusChip("waiting")).toEqual({ label: "Waiting", tone: "waiting" });
    expect(statusChip("started").tone).toBe("started");
    expect(statusChip("declined").tone).toBe("declined");
    expect(statusChip("expired")).toEqual({ label: "Expired", tone: "ended" });
    expect(statusChip("refused")).toEqual({ label: "Refused", tone: "ended" });
  });

  it("keeps the journal short", () => {
    const many = Array.from({ length: JOURNAL_MAX + 3 }, (_, i) => request({ id: `r${i}` }));
    expect(journalEntries(state(many))).toHaveLength(JOURNAL_MAX);
    expect(journalEntries(null)).toEqual([]);
  });

  it("dates older entries, not today's", () => {
    const today = new Date(NOW);
    today.setHours(9, 5, 0, 0);
    expect(journalTimeLabel(today.toISOString(), NOW)).toMatch(/^09:05$/);
    const earlier = new Date(NOW - 3 * 86_400_000);
    expect(journalTimeLabel(earlier.toISOString(), NOW)).toContain(",");
  });

  it("shows the server's sentence on a failure", () => {
    expect(failureMessage({ _tag: "ChatRequestsError", message: "2 chats at once already." })).toBe(
      "2 chats at once already.",
    );
    expect(failureMessage(undefined)).toMatch(/didn't answer/);
  });
});

describe("T51 session requests from a colleague", () => {
  const team = {
    requestId: 77,
    projectId: 512,
    projectName: "landing",
    fromUserId: 2731,
    fromName: "Andrei Petrov",
    viaAgent: true,
    level: "answer" as const,
    auto: false,
  };

  it("splits own requests from the team's", () => {
    const s = state([request({ id: "own" }), request({ id: "team", team })]);
    expect(ownWaitingRequests(s, NOW).map((q) => q.id)).toEqual(["own"]);
    expect(teamWaitingRequests(s, NOW).map((q) => q.id)).toEqual(["team"]);
    expect(waitingCount(s, NOW)).toBe(2);
  });

  it("titles a team request by the colleague", () => {
    expect(requestTitle(request({ team }))).toBe("Andrei's agent suggests starting a session here");
    expect(requestTitle(request({ team: { ...team, viaAgent: false } }))).toBe(
      "Andrei suggests starting a session here",
    );
  });
});
