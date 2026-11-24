import type { ThreadPendingForYou, ThreadPendingItem } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { inboxPendingAction, pendingItemBody } from "./inboxPendingForYou.ts";

const STARTED = "2026-11-23T10:00:00.000Z";

const item = (id: string, title: string, createdAt = "2026-11-23T10:05:00.000Z") =>
  ({
    id,
    kind: "card",
    title,
    createdAt,
    answersYou: false,
    broughtByThreadId: null,
    messageId: null,
    activityId: `a-${id}`,
    attachmentId: id,
    links: [],
  }) as unknown as ThreadPendingItem;

const list = (...items: ThreadPendingItem[]): ThreadPendingForYou => ({
  items,
  hidden: [],
  replacedActivityIds: [],
});

describe("inboxPendingAction", () => {
  it("posts when something new waits, with the count and the titles", () => {
    const action = inboxPendingAction({
      everSeen: new Set(),
      lastIds: undefined,
      pending: list(item("a", "Ship on Thursday?"), item("b", "Pricing"), item("c", "Banners")),
      startedAt: STARTED,
    });
    expect(action).toEqual({
      type: "post",
      body: "Waiting for you · 3: Ship on Thursday? · Pricing · +1",
    });
  });

  it("updates the line when the list shrank, reads it when nothing waits", () => {
    expect(
      inboxPendingAction({
        everSeen: new Set(["a", "b"]),
        lastIds: ["a", "b"],
        pending: list(item("b", "Pricing")),
        startedAt: STARTED,
      }),
    ).toEqual({ type: "update", body: pendingItemBody(list(item("b", "Pricing"))) });
    expect(
      inboxPendingAction({
        everSeen: new Set(["b"]),
        lastIds: ["b"],
        pending: list(),
        startedAt: STARTED,
      }),
    ).toEqual({ type: "resolve" });
    expect(
      inboxPendingAction({ everSeen: new Set(), lastIds: [], pending: list(), startedAt: STARTED }),
    ).toBeNull();
  });

  it("a restart or a restored item is not news", () => {
    const old = item("a", "Old", "2026-11-22T10:00:00.000Z");
    expect(
      inboxPendingAction({
        everSeen: new Set(),
        lastIds: undefined,
        pending: list(old),
        startedAt: STARTED,
      }),
    ).toEqual({ type: "update", body: pendingItemBody(list(old)) });
    expect(
      inboxPendingAction({
        everSeen: new Set(["a", "b"]),
        lastIds: ["b"],
        pending: list(item("a", "A"), item("b", "B")),
        startedAt: STARTED,
      })?.type,
    ).toBe("update");
  });
});
