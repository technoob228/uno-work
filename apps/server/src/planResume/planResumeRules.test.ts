import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  decideDue,
  FRESH_STOP_MS,
  hadItsTry,
  stopLineOf,
  type PlanResumeRow,
  type ThreadState,
  type ThreadTail,
} from "./planResumeRules.ts";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const STOP = "You've hit your limit · resets 3pm (UTC)";
const turn = TurnId.make("turn-1");

const state = (over: Partial<ThreadState> = {}): ThreadState => ({
  archived: false,
  sessionStatus: "ready",
  activeTurnId: null,
  latestTurnId: turn,
  latestTurnState: "completed",
  ...over,
});

const tail = (over: Partial<ThreadTail> = {}): ThreadTail => ({
  latest: {
    role: "assistant",
    text: STOP,
    streaming: false,
    createdAt: new Date(NOW - 1000).toISOString(),
  },
  lastUserMessageId: "m-1",
  ...over,
});

const row: PlanResumeRow = {
  resumeId: "r-1",
  threadId: ThreadId.make("t-1"),
  stoppedTurnId: turn,
  lastUserMessageId: "m-1",
  resumeAt: new Date(NOW).toISOString(),
};

describe("stopLineOf", () => {
  const read = (input: { state?: ThreadState; tail?: ThreadTail; sessionError?: string | null }) =>
    stopLineOf({
      state: input.state ?? state(),
      tail: input.tail ?? tail(),
      sessionError: input.sessionError ?? null,
      now: NOW,
    });

  it("reads Claude Code's stop line from the last reply of a finished turn", () => {
    expect(read({})).toBe(STOP);
  });

  it("reads Codex's stop line from the failed turn's error", () => {
    const error = "You've hit your usage limit. Try again at 3:05 PM.";
    expect(
      read({
        state: state({ sessionStatus: "error" }),
        sessionError: error,
        tail: tail({ latest: null }),
      }),
    ).toBe(error);
  });

  it("ignores a chat still working, stopped by the person, or archived", () => {
    expect(read({ state: state({ sessionStatus: "running" }) })).toBeNull();
    expect(read({ state: state({ activeTurnId: turn }) })).toBeNull();
    expect(read({ state: state({ latestTurnState: "interrupted" }) })).toBeNull();
    expect(read({ state: state({ archived: true }) })).toBeNull();
  });

  it("ignores an answer that only mentions limits, and a warning", () => {
    expect(
      read({
        tail: tail({
          latest: {
            role: "assistant",
            text: "You're approaching your usage limit reached soon",
            streaming: false,
            createdAt: new Date(NOW).toISOString(),
          },
        }),
      }),
    ).toBeNull();
  });

  it("ignores an old stop: a session starting again isn't a chat stopping now", () => {
    expect(
      read({
        tail: tail({
          latest: {
            role: "assistant",
            text: STOP,
            streaming: false,
            createdAt: new Date(NOW - FRESH_STOP_MS - 1).toISOString(),
          },
        }),
      }),
    ).toBeNull();
  });

  it("waits for the reply to finish streaming", () => {
    expect(
      read({
        tail: tail({
          latest: {
            role: "assistant",
            text: STOP,
            streaming: true,
            createdAt: new Date(NOW).toISOString(),
          },
        }),
      }),
    ).toBeNull();
  });
});

describe("one automatic try per case", () => {
  it("knows the daemon's own continuation as the last request", () => {
    expect(hadItsTry(tail({ lastUserMessageId: "plan-resume:r-1" }))).toBe(true);
    expect(hadItsTry(tail({ lastUserMessageId: "m-2" }))).toBe(false);
    expect(hadItsTry(tail({ lastUserMessageId: null }))).toBe(false);
  });
});

describe("decideDue", () => {
  it("resumes the chat that stopped", () => {
    expect(decideDue({ row, state: state(), tail: tail() })).toEqual({ kind: "resume" });
  });

  it("resumes after a restart of the daemon, when the session is gone", () => {
    expect(decideDue({ row, state: state({ sessionStatus: "stopped" }), tail: tail() })).toEqual({
      kind: "resume",
    });
  });

  it("leaves a chat the person wrote in", () => {
    expect(decideDue({ row, state: state(), tail: tail({ lastUserMessageId: "m-2" }) })).toEqual({
      kind: "end",
      reason: "someone-went-on",
    });
  });

  it("leaves a chat with a newer turn, or one working now", () => {
    expect(
      decideDue({ row, state: state({ latestTurnId: TurnId.make("turn-2") }), tail: tail() }),
    ).toMatchObject({ kind: "end" });
    expect(
      decideDue({ row, state: state({ sessionStatus: "running" }), tail: tail() }),
    ).toMatchObject({ kind: "end" });
  });

  it("leaves a chat that is gone or archived", () => {
    expect(decideDue({ row, state: null, tail: tail() })).toEqual({
      kind: "end",
      reason: "chat-gone",
    });
    expect(decideDue({ row, state: state({ archived: true }), tail: tail() })).toEqual({
      kind: "end",
      reason: "chat-gone",
    });
  });
});
