import { describe, expect, it } from "vitest";

import {
  dropLetter,
  EMPTY_PUSH_STATE,
  formatPushNotice,
  handedWatchOf,
  noticeFromProbe,
  pruneWatches,
  queueLetter,
  renewHanded,
  watchHanded,
  PUSH_NOTICE_MARKER,
  type PushNotice,
} from "./assistantPush.ts";
import type { SettledProbe } from "./threadSettlement.ts";

const HANDED_AT = "2026-11-24T10:00:00.000Z";
const nowMs = Date.parse("2026-11-24T10:12:05.000Z");

const probe = (
  status: SettledProbe["verdict"]["status"],
  requestedAt = "2026-11-24T10:01:00.000Z",
): SettledProbe => ({
  verdict: {
    settled: true,
    status,
    turn: {
      turnId: "turn-1" as never,
      state: "completed" as const,
      requestedAt,
      startedAt: requestedAt,
      completedAt: "2026-11-24T10:12:00.000Z",
      assistantMessageId: null,
      checkpointStatus: "ready" as never,
      checkpointFiles: [] as never,
    },
    error: status === "error" ? "boom" : null,
  },
  reply: {
    id: "m1",
    role: "assistant",
    text: "Checkout is live in test mode",
    streaming: false,
    createdAt: "2026-11-24T10:12:00.000Z",
  },
  pendingRequest: status === "needs_user" ? "Allow deploy?" : null,
  pendingApprovals: [],
});

const handed = watchHanded(EMPTY_PUSH_STATE, {
  threadId: "pricing",
  handlerThreadId: "coordinator",
  handlerProjectId: "launch",
  at: HANDED_AT,
});
const watch = handedWatchOf(handed, "pricing")!;

describe("handed chats (T63 Hand to…)", () => {
  it("watches the chat for its handler", () => {
    expect(watch).toMatchObject({
      threadId: "pricing",
      conversationThreadId: "coordinator",
      assistantProjectId: "launch",
      handed: true,
      via: null,
    });
  });

  it("a Ready goes to the handler and keeps the watch", () => {
    const result = noticeFromProbe({
      watch,
      probe: probe("completed"),
      title: "Pricing page",
      project: null,
      sentKeys: new Set(),
      nowMs,
    });
    expect(result?.endsWatch).toBe(false);
    expect(result?.notice).toMatchObject({ handed: true, outcome: "completed" });
  });

  it("an approval or a question stays with the person", () => {
    expect(
      noticeFromProbe({
        watch,
        probe: probe("needs_user"),
        title: "Pricing page",
        project: null,
        sentKeys: new Set(),
        nowMs,
      }),
    ).toBeNull();
  });

  it("a new turn renews what counts as its outcome; an older one doesn't", () => {
    const renewed = renewHanded(handed, "pricing", "2026-11-24T11:00:00.000Z");
    expect(handedWatchOf(renewed, "pricing")?.since).toBe("2026-11-24T11:00:00.000Z");
    expect(renewHanded(renewed, "pricing", HANDED_AT)).toBe(renewed);
    // The turn before the renewal is no longer its outcome.
    expect(
      noticeFromProbe({
        watch: handedWatchOf(renewed, "pricing")!,
        probe: probe("completed"),
        title: "Pricing page",
        project: null,
        sentKeys: new Set(),
        nowMs,
      }),
    ).toBeNull();
  });

  it("never expires while handed", () => {
    expect(pruneWatches(handed, nowMs + 30 * 24 * 60 * 60_000).watches).toHaveLength(1);
  });

  it("letters queue once and drop by key", () => {
    const letter = { key: "k", conversationThreadId: "coordinator", text: "brief", at: HANDED_AT };
    const queued = queueLetter(queueLetter(handed, letter), letter);
    expect(queued.letters).toEqual([letter]);
    expect(dropLetter(queued, "k").letters).toEqual([]);
  });

  it("tells the handler to drive it and report only the result, a decision or stuck", () => {
    const notice: PushNotice = {
      key: "pricing|turn-1|completed",
      threadId: "pricing",
      title: "Pricing page",
      project: null,
      outcome: "completed",
      assistantProjectId: "launch",
      conversationThreadId: "coordinator",
      via: null,
      elapsedMs: 60_000,
      changedFiles: null,
      excerpt: null,
      request: null,
      error: null,
      handed: true,
      at: new Date(nowMs).toISOString(),
    };
    const text = formatPushNotice([notice]);
    expect(text.startsWith(PUSH_NOTICE_MARKER)).toBe(true);
    expect(text).toContain("A chat the person handed you has settled.");
    expect(text).toContain("chat_message");
    expect(text).toContain("the result, a decision you can't make, or that one is stuck");
    // Mixed with an assistant's own hand-off: both sections.
    const mixed = formatPushNotice([{ ...notice, handed: undefined, threadId: "x" }, notice]);
    expect(mixed).toContain("A chat you handed work to has settled.");
    expect(mixed).toContain("A chat the person handed you has settled.");
  });
});
