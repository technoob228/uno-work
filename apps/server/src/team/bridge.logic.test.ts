import { describe, expect, it } from "vitest";

import type { HostRecord } from "../chatRequests/hostLogic.ts";
import {
  ANSWER_MAX_CHARS,
  answerStep,
  answersOnItsOwn,
  dueReports,
  retiredBy,
  startsOnItsOwn,
  teamFileOf,
} from "./bridge.logic.ts";
import { NO_PARTS, type TeamRequest } from "./teamCloud.logic.ts";

const ALL = { share: true, requests: true, agents: true, tasks: true };

const request = (over: Partial<TeamRequest> = {}): TeamRequest => ({
  id: 41,
  rev: 1,
  projectId: 7,
  projectName: "Shop",
  from: { userId: 9, email: "andrei@example.com", username: null },
  to: { userId: 3, email: "misha@example.com", username: "misha" },
  kind: "session",
  viaAgent: true,
  fromChatTitle: "Checkout bug",
  fromThread: null,
  title: "Fix the cart total",
  gist: "The total skips the discount.",
  body: "Please look at cart.ts: the total skips the discount.",
  level: "tasks",
  levelNow: "tasks",
  auto: true,
  status: "waiting",
  reason: null,
  answer: null,
  threadTitle: null,
  createdAt: "2026-11-20T10:00:00Z",
  expiresAt: "2026-11-21T10:00:00Z",
  stopRequested: false,
  chatId: null,
  ...over,
});

const record = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "team-41",
  status: "waiting",
  createdAt: "2026-11-20T10:00:00Z",
  expiresAt: "2026-11-21T10:00:00Z",
  receivedAt: "2026-11-20T10:00:01Z",
  decidedAt: null,
  updatedAt: "2026-11-20T10:00:01Z",
  from: { computerName: "andrei's computer", boxId: null, threadId: "t", threadTitle: "" },
  cwd: "/p/shop",
  provider: "claudeAgent",
  model: null,
  runtimeMode: null,
  title: "Fix the cart total",
  gist: "",
  brief: "",
  reason: null,
  threadId: null,
  threadTitle: null,
  threadState: null,
  lastMessage: null,
  threadUpdatedAt: null,
  ...over,
});

describe("a colleague's session as a host record", () => {
  it("carries the team, the folder and the guarded provider", () => {
    const file = teamFileOf(request(), "/p/shop");
    expect(file).toMatchObject({
      id: "team-41",
      cwd: "/p/shop",
      provider: "claudeAgent",
      title: "Fix the cart total",
      brief: "Please look at cart.ts: the total skips the discount.",
      from: { computerName: "andrei's computer", boxId: null, threadId: "team-request-41" },
      team: { requestId: 41, projectId: 7, fromUserId: 9, fromName: "andrei", auto: true },
    });
  });

  it("auto only while the level now is Do tasks", () => {
    expect(teamFileOf(request({ levelNow: "answer" }), "/p").team.auto).toBe(false);
    expect(teamFileOf(request({ auto: false }), "/p").team.auto).toBe(false);
  });

  it("empty fields get words, long ones are cut", () => {
    const file = teamFileOf(request({ title: " ", body: "", gist: "" }), "/p");
    expect(file.title).toBe("A task from andrei");
    expect(file.brief).toBe("A task from andrei");
    const long = teamFileOf(request({ title: "x".repeat(500) }), "/p");
    expect(long.title.length).toBeLessThan(500);
    expect(long.title.endsWith("…")).toBe(true);
  });
});

describe("what the cloud hears of a record", () => {
  it("nothing while it waits", () => {
    expect(dueReports(record(), [])).toEqual([]);
  });

  it("started, then done with the chat's last message", () => {
    const done = record({
      status: "started",
      threadTitle: "Fix the cart total",
      threadState: "done",
      lastMessage: "Fixed in cart.ts.",
    });
    expect(dueReports(done, []).map((report) => report.input)).toEqual([
      { status: "started", threadTitle: "Fix the cart total" },
      { status: "done", answer: "Fixed in cart.ts." },
    ]);
    expect(dueReports(done, ["started"]).map((report) => report.key)).toEqual(["done"]);
    expect(dueReports(done, ["started", "done"])).toEqual([]);
  });

  it("a failed chat is done with a reason; a stopped one is stopped", () => {
    expect(dueReports(record({ status: "started", threadState: "failed" }), ["started"])).toEqual([
      { key: "done", input: { status: "done", reason: "The chat stopped with an error." } },
    ]);
    expect(
      dueReports(record({ status: "started", threadState: "stopped" }), ["started"])[0]?.input,
    ).toEqual({ status: "stopped" });
  });

  it("declined, expired and refused once, with the reason", () => {
    expect(dueReports(record({ status: "declined", reason: "Not now." }), [])).toEqual([
      { key: "declined", input: { status: "declined", reason: "Not now." } },
    ]);
    expect(dueReports(record({ status: "expired" }), ["expired"])).toEqual([]);
  });
});

describe("who starts what on their own", () => {
  it("a question at Answer questions with agents on", () => {
    const question = request({ kind: "question", levelNow: "answer" });
    expect(answersOnItsOwn(question, ALL)).toBe(true);
    expect(answersOnItsOwn({ ...question, levelNow: "ask" }, ALL)).toBe(false);
    expect(answersOnItsOwn(question, { ...ALL, agents: false })).toBe(false);
    expect(answersOnItsOwn({ ...question, status: "answered" }, ALL)).toBe(false);
    expect(answersOnItsOwn(request(), ALL)).toBe(false);
  });

  it("a session at Do tasks only when the level read again says so", () => {
    const levels = { effectiveIn: { "9": "tasks" as const }, effectiveOut: {} };
    expect(startsOnItsOwn(request(), ALL, levels)).toBe(true);
    expect(
      startsOnItsOwn(request(), ALL, { effectiveIn: { "9": "answer" }, effectiveOut: {} }),
    ).toBe(false);
    expect(startsOnItsOwn(request(), ALL, null)).toBe(false);
    expect(startsOnItsOwn(request(), { ...ALL, tasks: false }, levels)).toBe(false);
    expect(startsOnItsOwn(request({ auto: false }), ALL, levels)).toBe(false);
    expect(startsOnItsOwn(request(), NO_PARTS, levels)).toBe(false);
  });
});

describe("a read-only answer", () => {
  it("waits while the chat works", () => {
    expect(answerStep({ state: "running", lastMessage: "half" })).toBeNull();
    expect(answerStep({ state: "waiting-for-you", lastMessage: null })).toBeNull();
  });

  it("answered with the last message, cut to the limit", () => {
    expect(answerStep({ state: "done", lastMessage: "  It is 42. " })).toEqual({
      status: "answered",
      answer: "It is 42.",
    });
    const long = answerStep({ state: "done", lastMessage: "y".repeat(ANSWER_MAX_CHARS + 50) });
    expect(long?.answer?.length).toBe(ANSWER_MAX_CHARS);
  });

  it("refused when gone, failed or empty; stopped when stopped", () => {
    expect(answerStep(null)?.status).toBe("refused");
    expect(answerStep({ state: "failed", lastMessage: "x" })?.status).toBe("refused");
    expect(answerStep({ state: "done", lastMessage: " " })?.status).toBe("refused");
    expect(answerStep({ state: "stopped", lastMessage: "x" })?.status).toBe("stopped");
  });
});

describe("a request over elsewhere", () => {
  it("cancelled, expired, declined: retired with a reason", () => {
    expect(retiredBy(request({ status: "cancelled" }))).toEqual({
      status: "refused",
      reason: "The colleague cancelled it.",
    });
    expect(retiredBy(request({ status: "expired", reason: "Too late." }))).toEqual({
      status: "expired",
      reason: "Too late.",
    });
    expect(retiredBy(request({ status: "declined" }))?.status).toBe("refused");
    expect(retiredBy(request())).toBeNull();
  });
});
