import { describe, expect, it } from "vitest";

import * as ThreadUndo from "./threadUndo";

describe("thread undo ownership", () => {
  it("does not revive the first Undo after a later unpin of the same chat", () => {
    const firstUnpin = ThreadUndo.begin("unpin", "env/thread");
    ThreadUndo.invalidate("unpin", "env/thread");
    const secondUnpin = ThreadUndo.begin("unpin", "env/thread");
    expect(firstUnpin.isCurrent()).toBe(false);
    expect(secondUnpin.isCurrent()).toBe(true);
    firstUnpin.finish();
    expect(secondUnpin.isCurrent()).toBe(true);
    secondUnpin.finish();
    expect(firstUnpin.isCurrent()).toBe(false);
  });

  it("expires an Undo without touching another computer or chat", () => {
    const first = ThreadUndo.begin("settle", "one/thread");
    const otherEnvironment = ThreadUndo.begin("settle", "two/thread");
    const otherThread = ThreadUndo.begin("settle", "one/other");
    first.finish();
    expect(first.isCurrent()).toBe(false);
    expect(otherEnvironment.isCurrent()).toBe(true);
    expect(otherThread.isCurrent()).toBe(true);
    otherEnvironment.finish();
    otherThread.finish();
  });

  it("keeps kinds apart: a snooze claim survives a settle of the same chat", () => {
    const snooze = ThreadUndo.begin("snooze", "env/thread");
    const settle = ThreadUndo.begin("settle", "env/thread");
    ThreadUndo.invalidate("settle", "env/thread");
    expect(settle.isCurrent()).toBe(false);
    expect(snooze.isCurrent()).toBe(true);
    snooze.finish();
  });

  it("tells subscribers when claims change", () => {
    let calls = 0;
    const unsubscribe = ThreadUndo.subscribe(() => {
      calls += 1;
    });
    const claim = ThreadUndo.begin("archive", "env/thread");
    claim.finish();
    ThreadUndo.invalidate("archive", "env/thread"); // already gone: no news
    unsubscribe();
    expect(calls).toBe(2);
  });
});

describe("planThreadUndo", () => {
  it("wakes a snoozed chat and unarchives an archived one", () => {
    expect(ThreadUndo.planThreadUndo("snooze")).toEqual([{ action: "unsnooze" }]);
    expect(ThreadUndo.planThreadUndo("archive")).toEqual([{ action: "unarchive" }]);
  });

  it("re-pins with the old pin time, so the chat keeps its place", () => {
    expect(ThreadUndo.planThreadUndo("unpin", { pinnedAt: "2026-10-01T10:00:00.000Z" })).toEqual([
      { action: "pin", pinnedAt: "2026-10-01T10:00:00.000Z" },
    ]);
  });

  it("restores the pin and the snooze that Done cleared", () => {
    expect(
      ThreadUndo.planThreadUndo("settle", {
        pinnedAt: "2026-10-01T10:00:00.000Z",
        snoozedUntil: "2026-11-01T09:00:00.000Z",
      }),
    ).toEqual([
      { action: "unsettle" },
      { action: "pin", pinnedAt: "2026-10-01T10:00:00.000Z" },
      { action: "snooze", snoozedUntil: "2026-11-01T09:00:00.000Z" },
    ]);
    expect(ThreadUndo.planThreadUndo("settle", { pinnedAt: null })).toEqual([
      { action: "unsettle" },
    ]);
  });
});

describe("executeThreadUndo", () => {
  it("runs the steps in order and skips a snooze that has already expired", async () => {
    const ran: string[] = [];
    await ThreadUndo.executeThreadUndo(
      [
        { action: "unsettle" },
        { action: "pin", pinnedAt: "2026-10-01T10:00:00.000Z" },
        { action: "snooze", snoozedUntil: "2026-10-29T09:00:00.000Z" },
      ],
      async (step) => {
        ran.push(step.action);
      },
      () => Date.parse("2026-10-29T12:00:00.000Z"),
    );
    expect(ran).toEqual(["unsettle", "pin"]);
  });

  it("stops at the first failing step", async () => {
    const ran: string[] = [];
    await expect(
      ThreadUndo.executeThreadUndo(
        [{ action: "unsettle" }, { action: "pin", pinnedAt: "2026-10-01T10:00:00.000Z" }],
        async (step) => {
          ran.push(step.action);
          if (step.action === "unsettle") throw new Error("offline");
        },
      ),
    ).rejects.toThrow("offline");
    expect(ran).toEqual(["unsettle"]);
  });
});
