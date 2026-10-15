import { describe, expect, it } from "vitest";

import {
  type NeedsYouInboxItem,
  questionItemIdsToSkip,
  resolveInboxItemActions,
  skipForNowPresets,
  skippedQuestionThreadKeys,
} from "./inboxActions.logic";

const WAITS_FOR_OK = { approval: true, input: false };
const ASKS = { approval: false, input: true };
const NOTHING = { approval: false, input: false };

describe("approval actions", () => {
  const base = { kind: "agent.approval" as const, hasThread: true, unread: true };

  it("pending: Allow / Decline / View, nothing that drops the request", () => {
    const actions = resolveInboxItemActions({
      ...base,
      open: WAITS_FOR_OK,
      approvalPhase: "pending",
    });
    expect(actions.reason).toBe("approval");
    expect(actions.buttons).toEqual(["allow", "decline", "view"]);
    expect(actions).toMatchObject({ done: false, markRead: false, snooze: false, skip: false });
  });

  it("loading: View only", () => {
    const actions = resolveInboxItemActions({
      ...base,
      open: WAITS_FOR_OK,
      approvalPhase: "loading",
    });
    expect(actions.buttons).toEqual(["view"]);
    expect(actions).toMatchObject({ done: false, markRead: false, snooze: false, skip: false });
  });

  it("answered: View + Done", () => {
    const actions = resolveInboxItemActions({
      ...base,
      unread: false,
      open: NOTHING,
      approvalPhase: "answered",
    });
    expect(actions.buttons).toEqual(["view"]);
    expect(actions.done).toBe(true);
    expect(actions.skip).toBe(false);
  });

  it("no phase known is treated as answered", () => {
    expect(resolveInboxItemActions({ ...base, open: undefined }).buttons).toEqual(["view"]);
  });
});

describe("question actions", () => {
  const base = { kind: "agent.input" as const, hasThread: true };

  it("open in the chat: Open chat + Skip for now, never Done / Mark read", () => {
    const actions = resolveInboxItemActions({ ...base, unread: false, open: ASKS });
    expect(actions.reason).toBe("question");
    expect(actions.buttons).toEqual(["open-chat"]);
    expect(actions).toMatchObject({ skip: true, done: false, markRead: false, snooze: false });
  });

  it("a secret request / browser help (not in the chat's summary) waits while unread", () => {
    const actions = resolveInboxItemActions({ ...base, unread: true, open: NOTHING });
    expect(actions).toMatchObject({ skip: true, done: false });
  });

  it("answered: Open chat + Done", () => {
    const actions = resolveInboxItemActions({ ...base, unread: false, open: NOTHING });
    expect(actions.buttons).toEqual(["open-chat"]);
    expect(actions).toMatchObject({ skip: false, done: true, markRead: true });
  });
});

describe("other kinds keep their actions", () => {
  it.each(["agent.done", "agent.error", "app"] as const)(
    "%s: Open, Done, Snooze, Mark read",
    (kind) => {
      const actions = resolveInboxItemActions({ kind, hasThread: true, unread: true, open: ASKS });
      expect(actions.reason).toBe("other");
      expect(actions.buttons).toEqual(["open"]);
      expect(actions).toMatchObject({ done: true, snooze: true, markRead: true, skip: false });
    },
  );

  it("an approval that doesn't open a chat falls back to Open", () => {
    const actions = resolveInboxItemActions({
      kind: "agent.approval",
      hasThread: false,
      unread: true,
      open: undefined,
    });
    expect(actions.buttons).toEqual(["open"]);
  });
});

describe("Skip for now", () => {
  it("offers 1 hour, this evening and tomorrow morning — not next week", () => {
    // Monday 10:00 local.
    const ids = skipForNowPresets(new Date(2026, 9, 12, 10, 0)).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "evening", "tomorrow"]);
  });

  it("late in the day there's no evening left", () => {
    const ids = skipForNowPresets(new Date(2026, 9, 12, 22, 0)).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "tomorrow"]);
  });
});

function item(overrides: Partial<NeedsYouInboxItem> & { id: string }): NeedsYouInboxItem {
  return {
    environmentId: "env",
    kind: "agent.input",
    updatedAt: "2026-10-14T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    open: { kind: "thread", threadId: "t1" },
    ...overrides,
  };
}

describe("Home: skipped questions", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const LATER = "2026-10-14T13:00:00.000Z";
  const PAST = "2026-10-14T11:00:00.000Z";

  it("a chat whose newest question is snoozed is skipped", () => {
    expect(skippedQuestionThreadKeys([item({ id: "a", snoozedUntil: LATER })], NOW)).toEqual(
      new Set(["env:t1"]),
    );
  });

  it("comes back at the wake-up time", () => {
    expect(skippedQuestionThreadKeys([item({ id: "a", snoozedUntil: PAST })], NOW).size).toBe(0);
  });

  it("an older answered question doesn't keep it in, a newer unread one does", () => {
    const old = item({ id: "old", updatedAt: "2026-10-13T10:00:00.000Z", readAt: PAST });
    const skipped = item({ id: "new", snoozedUntil: LATER });
    expect(skippedQuestionThreadKeys([old, skipped], NOW)).toEqual(new Set(["env:t1"]));
    const fresh = item({ id: "fresh", updatedAt: "2026-10-14T11:30:00.000Z" });
    expect(skippedQuestionThreadKeys([old, skipped, fresh], NOW).size).toBe(0);
  });

  it("other kinds and other computers don't count", () => {
    const done = item({ id: "d", kind: "agent.done", snoozedUntil: LATER });
    const elsewhere = item({ id: "e", environmentId: "env2", snoozedUntil: LATER });
    expect(skippedQuestionThreadKeys([done, elsewhere], NOW)).toEqual(new Set(["env2:t1"]));
  });

  it("skipping snoozes unread questions and the newest one, never older answered ones", () => {
    const old = item({ id: "old", updatedAt: "2026-10-13T10:00:00.000Z", readAt: PAST });
    const newestRead = item({ id: "newest", readAt: PAST });
    const otherChat = item({ id: "x", open: { kind: "thread", threadId: "t2" } });
    expect(questionItemIdsToSkip([old, newestRead, otherChat], "env", "t1", NOW)).toEqual([
      "newest",
    ]);
    expect(questionItemIdsToSkip([], "env", "t1", NOW)).toEqual([]);
  });
});
