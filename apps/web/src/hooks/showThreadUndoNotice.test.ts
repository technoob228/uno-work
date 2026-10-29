import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ThreadUndo from "../lib/threadUndo";
import {
  THREAD_UNDO_NOTICE_TIMEOUT_MS,
  releaseThreadUndoShortcut,
  resetThreadUndoNoticeForTests,
  showThreadUndoNotice,
  threadUndoClaimsShortcut,
  threadUndoNoticeSummary,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "./showThreadUndoNotice";

function offer(action: "Done" | "Snoozed" | "Unpinned" | "Archived", key: string) {
  const undo = vi.fn(async () => {});
  const kind = { Done: "settle", Snoozed: "snooze", Unpinned: "unpin", Archived: "archive" } as const;
  showThreadUndoNotice({
    action,
    undo,
    failureTitle: "failed",
    claim: ThreadUndo.begin(kind[action], key),
  });
  return undo;
}

describe("showThreadUndoNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadUndoNoticeForTests();
  });
  afterEach(() => {
    resetThreadUndoNoticeForTests();
    vi.useRealTimers();
  });

  it("groups a run of the same action and undoes the whole group at once", async () => {
    const first = offer("Done", "env/a");
    const second = offer("Done", "env/b");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Done", count: 2 });
    expect(undoLatestThreadAction()).toBe(true);
    await vi.runAllTimersAsync();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    // Nothing left: ⌘Z goes back to the page.
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("undoes only the latest kind; the earlier one stays for the next ⌘Z", async () => {
    const snoozed = offer("Snoozed", "env/a");
    const archived = offer("Archived", "env/b");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    undoLatestThreadAction();
    await Promise.resolve();
    expect(archived).toHaveBeenCalledOnce();
    expect(snoozed).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
  });

  it("disappears after 5 seconds without undoing anything", () => {
    const undo = offer("Unpinned", "env/a");
    vi.advanceTimersByTime(THREAD_UNDO_NOTICE_TIMEOUT_MS);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(undo).not.toHaveBeenCalled();
  });

  it("drops an Undo the person already reversed by hand", () => {
    offer("Done", "env/a");
    ThreadUndo.invalidate("settle", "env/a");
    expect(useThreadUndoNotice.getState().notice).toBeNull();
  });

  it("claims ⌘Z right after the action until the person types something else", () => {
    offer("Done", "env/a");
    expect(threadUndoClaimsShortcut()).toBe(true);
    releaseThreadUndoShortcut();
    expect(threadUndoClaimsShortcut()).toBe(false);
  });

  it("speaks in chats", () => {
    expect(threadUndoNoticeSummary({ action: "Done", count: 1 })).toBe("Done 1 chat");
    expect(threadUndoNoticeSummary({ action: "Archived", count: 3 })).toBe("Archived 3 chats");
  });
});
