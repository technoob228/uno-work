import { THREAD_GOAL_ACTIVITY_KIND, type ThreadGoalState, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveThreadGoal, isThreadGoalShown } from "./threadGoal";

const state: ThreadGoalState = {
  goalId: "g1",
  goal: "The site works",
  status: "active",
  turnsUsed: 2,
  maxTurns: 10,
  costUsd: null,
  maxCostUsd: 10,
  startedAt: "2026-10-30T10:00:00.000Z",
  deadlineAt: "2026-10-30T11:00:00.000Z",
  endNote: null,
  lastTurnId: null,
};
const activity = (kind: string, payload: unknown) =>
  ({ kind, payload }) as Parameters<typeof deriveThreadGoal>[0] extends
    | ReadonlyArray<infer A>
    | undefined
    ? A
    : never;

describe("deriveThreadGoal", () => {
  it("takes the newest goal activity", () => {
    expect(
      deriveThreadGoal([
        activity(THREAD_GOAL_ACTIVITY_KIND, state),
        activity(THREAD_GOAL_ACTIVITY_KIND, { ...state, turnsUsed: 3 }),
        activity("tool.completed", {}),
      ])?.turnsUsed,
    ).toBe(3);
  });

  it("has none without one, and skips a payload it cannot read", () => {
    expect(deriveThreadGoal(undefined)).toBeNull();
    expect(deriveThreadGoal([activity(THREAD_GOAL_ACTIVITY_KIND, { nope: true })])).toBeNull();
  });
});

describe("isThreadGoalShown", () => {
  const ended = { ...state, status: "met" as const, lastTurnId: TurnId.make("t1") };
  const base = { dismissedGoalId: null, latestTurnId: "t1" };

  it("always shows a running goal", () => {
    expect(isThreadGoalShown(state, { dismissedGoalId: "g1", latestTurnId: "t9" })).toBe(true);
  });

  it("keeps an ended goal up until dismissed or the chat moves on", () => {
    expect(isThreadGoalShown(ended, base)).toBe(true);
    expect(isThreadGoalShown(ended, { ...base, dismissedGoalId: "g1" })).toBe(false);
    expect(isThreadGoalShown(ended, { ...base, latestTurnId: "t2" })).toBe(false);
  });
});
