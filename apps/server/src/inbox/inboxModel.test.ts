import { describe, expect, it } from "vitest";

import {
  INBOX_MAX_ITEMS,
  addToInbox,
  applyInboxUpdate,
  nextWakeAt,
  parseStoredItems,
  prune,
  toSnapshot,
  wakeSnoozed,
  type InboxPost,
  type StoredInboxItem,
} from "./inboxModel.ts";

const T0 = new Date("2026-09-24T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

const officePost = (title: string): InboxPost => ({
  kind: "app",
  source: { kind: "app", id: "office", name: "Office", icon: null },
  title,
  body: null,
  open: { kind: "file", path: "/home/u/report.docx" },
  groupKey: "office:share1:Boris",
});

describe("inbox model", () => {
  it("folds a repeat into the unread item instead of stacking, and starts anew once read", () => {
    let items: StoredInboxItem[] = [];
    items = addToInbox(items, officePost("Boris commented on report.docx"), T0, "a").items;
    items = addToInbox(items, officePost("Boris commented on report.docx"), later(1000), "b").items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "a", count: 2, updatedAt: later(1000).toISOString() });

    items = applyInboxUpdate(items, { action: "read", ids: ["a"] }, later(2000));
    items = addToInbox(items, officePost("Boris commented on report.docx"), later(3000), "c").items;
    expect(items.map((item) => item.id)).toEqual(["c", "a"]);
    expect(toSnapshot(items, later(3000).getTime()).unread).toBe(1);
  });

  it("strips control and bidi characters and cuts long text", () => {
    const { item } = addToInbox(
      [],
      {
        ...officePost(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(7)}c`),
        body: "x".repeat(900),
        groupKey: null,
      },
      T0,
    );
    expect(item.title).toBe("abc");
    expect(item.body?.length).toBe(500);
  });

  it("marks a thread's items read, snoozes into the future only, and wakes snoozed items unread", () => {
    let items: StoredInboxItem[] = [];
    items = addToInbox(
      items,
      {
        kind: "agent.done",
        source: { kind: "agent", id: "t1", name: "Landing page", icon: null },
        title: "Landing page",
        open: { kind: "thread", threadId: "t1" },
      },
      T0,
      "t1-done",
    ).items;
    items = addToInbox(items, officePost("Boris edited"), T0, "office").items;
    const read = applyInboxUpdate(items, { action: "read", threadId: "t1" }, later(1));
    expect(read.find((item) => item.id === "t1-done")?.readAt).not.toBeNull();
    expect(read.find((item) => item.id === "office")?.readAt).toBeNull();

    expect(() =>
      applyInboxUpdate(items, { action: "snooze", ids: ["office"], until: T0.toISOString() }, T0),
    ).toThrow("future");
    const snoozed = applyInboxUpdate(
      items,
      { action: "snooze", ids: ["office"], until: later(60_000).toISOString() },
      T0,
    );
    expect(toSnapshot(snoozed, T0.getTime()).unread).toBe(1);
    expect(nextWakeAt(snoozed, T0.getTime())).toBe(later(60_000).getTime());
    const woke = wakeSnoozed(snoozed, later(60_001).getTime());
    expect(woke.woke.map((item) => item.id)).toEqual(["office"]);
    expect(toSnapshot(woke.items, later(60_001).getTime()).unread).toBe(2);

    expect(applyInboxUpdate(items, { action: "dismiss", ids: ["office"] }, T0)).toHaveLength(1);
  });

  it("drops old read items first and keeps the list bounded", () => {
    const many: StoredInboxItem[] = [];
    for (let index = 0; index < INBOX_MAX_ITEMS + 20; index += 1) {
      many.push({
        ...addToInbox(
          [],
          { ...officePost(`n${index}`), groupKey: null },
          later(index * 1000),
          `i${index}`,
        ).item,
        readAt: index < 50 ? later(index * 1000).toISOString() : null,
      });
    }
    const kept = prune(many, later(10_000_000).getTime());
    expect(kept).toHaveLength(INBOX_MAX_ITEMS);
    expect(kept.filter((item) => item.readAt === null)).toHaveLength(INBOX_MAX_ITEMS + 20 - 50);
  });

  it("reads back what it wrote and skips broken entries", () => {
    const { items } = addToInbox([], officePost("Boris"), T0, "a");
    const parsed = parseStoredItems(
      JSON.parse(JSON.stringify({ version: 1, items: [...items, 5, { id: 1 }] })),
    );
    expect(parsed).toEqual(items);
  });
});
