import { afterEach, describe, expect, it } from "vitest";

import {
  BACKGROUND_TASK_MAX_AGE_MS,
  forgetSessionActivity,
  getSessionActivity,
  lastActivityMs,
  recordRuntimeEvent,
  resetSessionActivity,
} from "./sessionActivity.ts";

describe("sessionActivity", () => {
  afterEach(() => resetSessionActivity());

  it("knows nothing about a thread it has not seen", () => {
    expect(getSessionActivity("t")).toEqual({ lastEventMs: undefined, backgroundTaskCount: 0 });
  });

  it("tracks the last event and live background tasks", () => {
    recordRuntimeEvent({ threadId: "t", type: "turn.started" }, 1_000);
    recordRuntimeEvent(
      { threadId: "t", type: "task.started", payload: { taskId: "a", isBackgrounded: true } },
      2_000,
    );
    recordRuntimeEvent(
      { threadId: "t", type: "task.started", payload: { taskId: "b", isBackgrounded: true } },
      3_000,
    );
    expect(getSessionActivity("t", 4_000)).toEqual({ lastEventMs: 3_000, backgroundTaskCount: 2 });

    recordRuntimeEvent({ threadId: "t", type: "task.completed", payload: { taskId: "a" } }, 5_000);
    expect(getSessionActivity("t", 6_000)).toEqual({ lastEventMs: 5_000, backgroundTaskCount: 1 });
  });

  it("ignores tasks that are not backgrounded", () => {
    recordRuntimeEvent(
      { threadId: "t", type: "task.started", payload: { taskId: "fg", isBackgrounded: false } },
      1_000,
    );
    recordRuntimeEvent({ threadId: "t", type: "task.started", payload: { taskId: "fg2" } }, 1_000);
    expect(getSessionActivity("t", 2_000).backgroundTaskCount).toBe(0);
  });

  it("drops a background task that never reported completion after the age cap", () => {
    recordRuntimeEvent(
      { threadId: "t", type: "task.started", payload: { taskId: "a", isBackgrounded: true } },
      0,
    );
    expect(getSessionActivity("t", BACKGROUND_TASK_MAX_AGE_MS).backgroundTaskCount).toBe(1);
    expect(getSessionActivity("t", BACKGROUND_TASK_MAX_AGE_MS + 1).backgroundTaskCount).toBe(0);
  });

  it("forgets a thread when its harness exits or is stopped", () => {
    recordRuntimeEvent(
      { threadId: "t", type: "task.started", payload: { taskId: "a", isBackgrounded: true } },
      1_000,
    );
    recordRuntimeEvent({ threadId: "t", type: "session.exited" }, 2_000);
    expect(getSessionActivity("t", 3_000).backgroundTaskCount).toBe(0);

    recordRuntimeEvent(
      { threadId: "u", type: "task.started", payload: { taskId: "a", isBackgrounded: true } },
      1_000,
    );
    forgetSessionActivity("u");
    expect(getSessionActivity("u", 3_000).lastEventMs).toBeUndefined();
  });

  it("takes the later of the person's message and the agent's event", () => {
    expect(lastActivityMs(10, { lastEventMs: undefined, backgroundTaskCount: 0 })).toBe(10);
    expect(lastActivityMs(10, { lastEventMs: 50, backgroundTaskCount: 0 })).toBe(50);
    expect(lastActivityMs(90, { lastEventMs: 50, backgroundTaskCount: 0 })).toBe(90);
  });
});
