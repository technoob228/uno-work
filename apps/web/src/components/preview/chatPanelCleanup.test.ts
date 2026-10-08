import { describe, expect, it } from "vitest";

import {
  chatClosedMark,
  diffClosedChats,
  type ClosedChatEnvironment,
  type ClosedChatThread,
} from "./chatPanelCleanup";

function chat(id: string, patch: Partial<ClosedChatThread> = {}): ClosedChatThread {
  return { id, environmentId: "env-1", archivedAt: null, settledOverride: null, ...patch };
}

function machine(
  threads: ReadonlyArray<ClosedChatThread>,
  patch: Partial<ClosedChatEnvironment> = {},
): ClosedChatEnvironment {
  return { environmentId: "env-1", loaded: true, threads, ...patch };
}

const done = (at: string) => ({ settledOverride: "settled" as const, settledAt: at });

describe("chatClosedMark", () => {
  it("open chats have no mark; Done and archive carry their time", () => {
    expect(chatClosedMark(chat("a"))).toBeNull();
    expect(chatClosedMark(chat("a", { settledOverride: "active" }))).toBeNull();
    expect(chatClosedMark(chat("a", done("2026-10-08T10:00:00Z")))).toBe(
      "done:2026-10-08T10:00:00Z",
    );
    expect(chatClosedMark(chat("a", { archivedAt: "2026-10-08T11:00:00Z" }))).toBe(
      "archived:2026-10-08T11:00:00Z",
    );
  });
});

describe("diffClosedChats", () => {
  it("the first snapshot only remembers — chats already Done are left alone", () => {
    const result = diffClosedChats(null, [machine([chat("a", done("t1")), chat("b")])]);
    expect(result.closed).toEqual([]);
    expect(result.marks.size).toBe(2);
  });

  it("marking a chat Done or archiving it closes its panel", () => {
    const first = diffClosedChats(null, [machine([chat("a"), chat("b"), chat("c")])]);
    const next = diffClosedChats(first.marks, [
      machine([chat("a", done("t1")), chat("b", { archivedAt: "t2" }), chat("c")]),
    ]);
    expect(next.closed).toEqual(["a", "b"]);
  });

  it("looking at a Done chat again does not close what the person opened there", () => {
    const first = diffClosedChats(null, [machine([chat("a")])]);
    const isDone = diffClosedChats(first.marks, [machine([chat("a", done("t1"))])]);
    const later = diffClosedChats(isDone.marks, [machine([chat("a", done("t1"))])]);
    expect(later.closed).toEqual([]);
  });

  it("Done again after the chat came back closes it again", () => {
    let marks = diffClosedChats(null, [machine([chat("a", done("t1"))])]).marks;
    marks = diffClosedChats(marks, [machine([chat("a", { settledOverride: null })])]).marks;
    const again = diffClosedChats(marks, [machine([chat("a", done("t2"))])]);
    expect(again.closed).toEqual(["a"]);
  });

  it("archiving a Done chat closes it (nothing to lose, keeps the rule simple)", () => {
    const marks = diffClosedChats(null, [machine([chat("a", done("t1"))])]).marks;
    const archived = diffClosedChats(marks, [
      machine([chat("a", { ...done("t1"), archivedAt: "t2" })]),
    ]);
    expect(archived.closed).toEqual(["a"]);
  });

  it("bringing a chat back (unarchive, new message) never closes anything", () => {
    const marks = diffClosedChats(null, [machine([chat("a", { archivedAt: "t1" })])]).marks;
    expect(diffClosedChats(marks, [machine([chat("a")])]).closed).toEqual([]);
  });

  it("a deleted chat is closed once its machine's list has loaded", () => {
    const marks = diffClosedChats(null, [machine([chat("a"), chat("b")])]).marks;
    const result = diffClosedChats(marks, [machine([chat("b")])]);
    expect(result.closed).toEqual(["a"]);
    expect(result.marks.has("a")).toBe(false);
  });

  it("a machine that went away or is still loading keeps its chats' panels", () => {
    const marks = diffClosedChats(null, [machine([chat("a")])]).marks;
    const gone = diffClosedChats(marks, []);
    expect(gone.closed).toEqual([]);
    const loading = diffClosedChats(gone.marks, [machine([], { loaded: false })]);
    expect(loading.closed).toEqual([]);
    const back = diffClosedChats(loading.marks, [machine([chat("a", done("t1"))])]);
    expect(back.closed).toEqual(["a"]);
  });
});
