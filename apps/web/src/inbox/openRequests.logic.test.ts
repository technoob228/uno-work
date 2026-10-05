import { describe, expect, it } from "vitest";

import {
  approvalPhase,
  canDismissInboxItem,
  canOfferChatDone,
  chatOpenRequests,
  chatWaitsForPerson,
  inboxIdsClearedByChatDone,
} from "./openRequests.logic";

const WAITS_FOR_OK = { approval: true, input: false };
const ASKS = { approval: false, input: true };
const NOTHING = { approval: false, input: false };

describe("chat Done (sidebar row, Home card)", () => {
  it("is never offered while the chat waits for an Allow or an answer, or works", () => {
    expect(canOfferChatDone("approval")).toBe(false);
    expect(canOfferChatDone("input")).toBe(false);
    expect(canOfferChatDone("working")).toBe(false);
    expect(canOfferChatDone("ready")).toBe(true);
    expect(canOfferChatDone("failed")).toBe(true);
    expect(chatWaitsForPerson("input")).toBe(true);
    expect(chatWaitsForPerson("failed")).toBe(false);
  });

  it("clears the chat's news but keeps an open or unresolved request", () => {
    const items = [
      {
        id: "done",
        kind: "agent.done" as const,
        readAt: null,
        open: { kind: "thread" as const, threadId: "t1" },
      },
      {
        id: "ok",
        kind: "agent.approval" as const,
        readAt: null,
        open: { kind: "thread" as const, threadId: "t1" },
      },
      // Opened (so read) but the chat still waits for the OK: keep it.
      {
        id: "ok-opened",
        kind: "agent.approval" as const,
        readAt: "2026-10-05T10:00:00Z",
        open: { kind: "thread" as const, threadId: "t1" },
      },
      {
        id: "other",
        kind: "agent.done" as const,
        readAt: null,
        open: { kind: "thread" as const, threadId: "t2" },
      },
      { id: "app", kind: "app" as const, readAt: null, open: null },
    ];
    expect(inboxIdsClearedByChatDone(items, "t1", WAITS_FOR_OK)).toEqual(["done"]);
    // Answered: the resolved (read) approval goes too, an unread one never does.
    expect(inboxIdsClearedByChatDone(items, "t1", NOTHING)).toEqual(["done", "ok-opened"]);
  });
});

describe("Inbox item Done / Dismiss", () => {
  it("is hidden for a request the chat still waits on", () => {
    expect(canDismissInboxItem("agent.approval", WAITS_FOR_OK)).toBe(false);
    expect(canDismissInboxItem("agent.input", ASKS)).toBe(false);
    expect(canDismissInboxItem("agent.input", WAITS_FOR_OK)).toBe(true);
    expect(canDismissInboxItem("agent.approval", NOTHING)).toBe(true);
    expect(canDismissInboxItem("agent.done", WAITS_FOR_OK)).toBe(true);
    expect(canDismissInboxItem("app", undefined)).toBe(true);
    // The chat is gone from this computer: nothing left to answer.
    expect(canDismissInboxItem("agent.approval", undefined)).toBe(true);
  });
});

describe("approvalPhase", () => {
  it("tells 'still loading' from 'answered'", () => {
    expect(approvalPhase({ requestKnown: true, open: WAITS_FOR_OK })).toBe("pending");
    // The chat's details have not arrived yet but its summary says it waits.
    expect(approvalPhase({ requestKnown: false, open: WAITS_FOR_OK })).toBe("loading");
    expect(approvalPhase({ requestKnown: false, open: NOTHING })).toBe("answered");
    expect(approvalPhase({ requestKnown: false, open: undefined })).toBe("answered");
  });

  it("reads the chat summary", () => {
    expect(chatOpenRequests(undefined)).toBeUndefined();
    expect(chatOpenRequests({ hasPendingApprovals: true, hasPendingUserInput: false })).toEqual(
      WAITS_FOR_OK,
    );
  });
});
