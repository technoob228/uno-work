import type { ThreadPendingForYou, ThreadPendingItem } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { applyOptimistic, pendingEntryId } from "./usePendingForYou";

const item = (id: string, extra: Partial<ThreadPendingItem> = {}): ThreadPendingItem =>
  ({
    id,
    kind: "card",
    title: id,
    createdAt: "2026-11-23T10:00:00.000Z",
    answersYou: false,
    broughtByThreadId: null,
    messageId: null,
    activityId: `act-${id}`,
    attachmentId: id,
    links: [],
    ...extra,
  }) as ThreadPendingItem;

const none = { dismiss: new Set<string>(), restore: new Set<string>(), opened: new Set<string>() };

describe("usePendingForYou", () => {
  const pending: ThreadPendingForYou = {
    items: [
      item("c-old", { createdAt: "2026-11-23T09:00:00.000Z" }),
      item("links:a1", {
        kind: "links",
        activityId: null,
        attachmentId: null,
        messageId: "a1" as never,
        links: [
          { href: "https://a.uno4.me", label: "A", opened: false },
          { href: "https://b.uno4.me", label: "B", opened: true },
        ],
      }),
    ],
    hidden: [item("c-hidden")],
    replacedActivityIds: [],
  };

  it("shows what the person just did before the computer's copy arrives", () => {
    const view = applyOptimistic(
      pending,
      {
        dismiss: new Set(["c-old"]),
        restore: new Set(["c-hidden"]),
        opened: new Set(["https://a.uno4.me"]),
      },
      new Set(),
    );
    // The links item is done once its last link is opened.
    expect(view.items.map((entry) => entry.id)).toEqual(["c-hidden"]);
    expect(view.hidden.map((entry) => entry.id)).toEqual(["c-old"]);
  });

  it("a card answered from the page leaves at once; answers to the person go first", () => {
    const answered = applyOptimistic(pending, none, new Set(["c-old"]));
    expect(answered.items.map((entry) => entry.id)).toEqual(["links:a1"]);
    const withAnswer = applyOptimistic(
      { ...pending, items: [...pending.items, item("c-new", { answersYou: true })] },
      none,
      new Set(),
    );
    expect(withAnswer.items[0]?.id).toBe("c-new");
  });

  it("points a card at its page row and links at their message", () => {
    expect(pendingEntryId(pending.items[0]!)).toBe("html-render:act-c-old");
    expect(pendingEntryId(pending.items[1]!)).toBe("a1");
  });
});
