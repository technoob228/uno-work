import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_WIDGETS,
  addableWidgets,
  approvalQuestion,
  attentionThreads,
  greeting,
  homeThreadStatus,
  homeWidgetsReducer,
  normalizeHomeWidgets,
  pickContinueThreads,
  recentHomeEntries,
  recentThreads,
  shortAgo,
  type HomeThread,
} from "./homeModel";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function thread(id: string, patch: Partial<HomeThread> = {}): HomeThread {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: `Chat ${id}`,
    interactionMode: "default",
    session: null,
    createdAt: minutesAgo(600),
    archivedAt: null,
    pinnedAt: null,
    updatedAt: minutesAgo(300),
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  } as HomeThread;
}

const running = { status: "running" } as HomeThread["session"];
const doneTurn = (m: number) =>
  ({
    turnId: "t",
    state: "completed",
    requestedAt: minutesAgo(m + 1),
    startedAt: minutesAgo(m + 1),
    completedAt: minutesAgo(m),
    assistantMessageId: null,
  }) as unknown as HomeThread["latestTurn"];

describe("pickContinueThreads", () => {
  it("puts approvals, questions, working and unseen results first", () => {
    const threads = [
      thread("old", { updatedAt: minutesAgo(1) }),
      thread("done", { latestTurn: doneTurn(30), updatedAt: minutesAgo(30) }),
      thread("failed", {
        session: { status: "error" } as HomeThread["session"],
        updatedAt: minutesAgo(40),
      }),
      thread("working", { session: running, updatedAt: minutesAgo(50) }),
      thread("asks", { hasPendingUserInput: true, updatedAt: minutesAgo(90) }),
      thread("approve", { hasPendingApprovals: true, updatedAt: minutesAgo(200) }),
    ];
    expect(pickContinueThreads(threads, { now: NOW }).map((t) => t.id)).toEqual([
      "approve",
      "asks",
      "working",
    ]);
    expect(pickContinueThreads(threads, { now: NOW, limit: 6 }).map((t) => t.id)).toEqual([
      "approve",
      "asks",
      "working",
      "done",
      "failed",
      "old",
    ]);
  });

  it("fills up with the most recent chats and skips archived, Helper and snoozed ones", () => {
    const threads = [
      thread("a", { updatedAt: minutesAgo(10) }),
      thread("b", { updatedAt: minutesAgo(5) }),
      thread("archived", { updatedAt: minutesAgo(1), archivedAt: minutesAgo(1) }),
      thread("helper", { updatedAt: minutesAgo(1), projectId: "assistant-home" as never }),
      thread("snoozed", {
        updatedAt: minutesAgo(1),
        snoozedUntil: new Date(NOW + 60_000).toISOString(),
      }),
      thread("settled", { updatedAt: minutesAgo(2), settledOverride: "settled" }),
      thread("c", { updatedAt: minutesAgo(20) }),
    ];
    expect(pickContinueThreads(threads, { now: NOW }).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("a result already seen is just a recent chat", () => {
    const seen = thread("seen", {
      latestTurn: doneTurn(30),
      lastVisitedAt: minutesAgo(10),
      updatedAt: minutesAgo(30),
    });
    const newer = thread("newer", { updatedAt: minutesAgo(20) });
    expect(pickContinueThreads([seen, newer], { now: NOW }).map((t) => t.id)).toEqual([
      "newer",
      "seen",
    ]);
  });
});

describe("attentionThreads", () => {
  it("lists approvals before questions, newest first", () => {
    const threads = [
      thread("q-new", { hasPendingUserInput: true, updatedAt: minutesAgo(1) }),
      thread("a-old", { hasPendingApprovals: true, updatedAt: minutesAgo(100) }),
      thread("a-new", { hasPendingApprovals: true, updatedAt: minutesAgo(5) }),
      thread("quiet", { updatedAt: minutesAgo(0) }),
      thread("archived", { hasPendingApprovals: true, archivedAt: minutesAgo(1) }),
    ];
    expect(attentionThreads(threads, NOW).map((t) => t.id)).toEqual(["a-new", "a-old", "q-new"]);
  });
});

describe("recentThreads", () => {
  it("is newest first and capped", () => {
    const threads = [1, 2, 3, 4].map((n) => thread(`t${n}`, { updatedAt: minutesAgo(n) }));
    expect(recentThreads(threads, { now: NOW, limit: 2 }).map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("words", () => {
  it("says the status plainly, like the sidebar reads it", () => {
    const label = (patch: Partial<HomeThread>) => homeThreadStatus(thread("x", patch))?.label;
    expect(label({ hasPendingApprovals: true })).toBe("Needs approval");
    expect(label({ hasPendingUserInput: true })).toBe("Asks you");
    expect(label({ session: running })).toBe("Working");
    expect(label({ session: { status: "error" } as HomeThread["session"] })).toBe("Failed");
    expect(label({ latestTurn: doneTurn(5) })).toBe("Done");
    expect(label({ latestTurn: doneTurn(5), lastVisitedAt: minutesAgo(1) })).toBeUndefined();
  });

  it("says how long ago, short", () => {
    expect(shortAgo(NOW - 20_000, NOW)).toBe("now");
    expect(shortAgo(NOW - 12 * 60_000, NOW)).toBe("12 min");
    expect(shortAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h");
    expect(shortAgo(NOW - 30 * 3_600_000, NOW)).toBe("yesterday");
    expect(shortAgo(NOW - 80 * 3_600_000, NOW)).toBe("3 d");
    expect(shortAgo(0, NOW)).toBe("");
  });

  it("greets by the time of day", () => {
    expect(greeting(3)).toBe("Good night");
    expect(greeting(9)).toBe("Good morning");
    expect(greeting(14)).toBe("Good afternoon");
    expect(greeting(21)).toBe("Good evening");
  });
});

describe("widget layout", () => {
  it("cleans a stored layout", () => {
    expect(normalizeHomeWidgets(["apps", "nope", "apps", "cloud", 3])).toEqual(["apps", "cloud"]);
    expect(normalizeHomeWidgets([])).toEqual([]);
    expect(normalizeHomeWidgets("garbage")).toEqual([...DEFAULT_HOME_WIDGETS]);
    expect(normalizeHomeWidgets(null)).toEqual([...DEFAULT_HOME_WIDGETS]);
  });

  it("adds, removes, moves and resets", () => {
    let state = homeWidgetsReducer(DEFAULT_HOME_WIDGETS, { type: "add", id: "cloud" });
    expect(state).toEqual(["files", "apps", "cloud"]);
    expect(homeWidgetsReducer(state, { type: "add", id: "cloud" })).toEqual(state);
    state = homeWidgetsReducer(state, { type: "move", from: "cloud", to: "files" });
    expect(state).toEqual(["cloud", "files", "apps"]);
    state = homeWidgetsReducer(state, { type: "move", from: "cloud", to: "apps" });
    expect(state).toEqual(["files", "apps", "cloud"]);
    expect(homeWidgetsReducer(state, { type: "move", from: "sites", to: "apps" })).toEqual(state);
    state = homeWidgetsReducer(state, { type: "remove", id: "files" });
    expect(state).toEqual(["apps", "cloud"]);
    expect(homeWidgetsReducer(state, { type: "reset" })).toEqual([...DEFAULT_HOME_WIDGETS]);
  });

  it("offers only what isn't on Home and is available here", () => {
    expect(addableWidgets(["files", "apps"], ["files", "apps", "cloud", "computer"])).toEqual([
      "cloud",
      "computer",
    ]);
  });
});

describe("recentHomeEntries", () => {
  it("shows the latest visible entries first", () => {
    const entry = (name: string, m: number, hidden = false) => ({
      name,
      hidden,
      modifiedAt: minutesAgo(m),
    });
    const entries = [
      entry("old.txt", 100),
      entry(".cache", 1, true),
      entry(".bashrc", 2),
      entry("new.docx", 5),
      entry("Projects", 10),
      { name: "broken", hidden: false, modifiedAt: "nope" },
    ];
    expect(recentHomeEntries(entries, 3).map((e) => e.name)).toEqual([
      "new.docx",
      "Projects",
      "old.txt",
    ]);
  });
});

describe("approvalQuestion", () => {
  it("asks about the agent's own detail, on one line", () => {
    expect(approvalQuestion({ requestKind: "command", detail: "npm install\n--save" })).toEqual({
      lead: "Run",
      subject: "npm install",
    });
    expect(approvalQuestion({ requestKind: "other", detail: "webfetch https://x.dev" })).toEqual({
      lead: "Allow",
      subject: "webfetch https://x.dev",
    });
    expect(
      approvalQuestion({ requestKind: "command", detail: "x".repeat(200) }).subject,
    ).toHaveLength(80);
  });

  it("says what kind of thing it is when there's no detail", () => {
    expect(approvalQuestion({ requestKind: "file-change" })).toEqual({
      lead: "Change files",
      subject: null,
    });
    expect(approvalQuestion({ requestKind: "other", detail: "  " })).toEqual({
      lead: "Go on",
      subject: null,
    });
  });
});
