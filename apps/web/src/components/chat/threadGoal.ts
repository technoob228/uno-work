import {
  THREAD_GOAL_ACTIVITY_KIND,
  ThreadGoalState,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { Schema } from "effect";

const isGoalState = Schema.is(ThreadGoalState);

/** The chat's goal: the newest word from the computer, however many came before it. */
export function deriveThreadGoal(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): ThreadGoalState | null {
  for (let index = (activities?.length ?? 0) - 1; index >= 0; index -= 1) {
    const activity = activities?.[index];
    if (activity?.kind === THREAD_GOAL_ACTIVITY_KIND && isGoalState(activity.payload)) {
      return activity.payload;
    }
  }
  return null;
}

/** An ended goal stays up until the person dismisses it or the chat moves on. */
export function isThreadGoalShown(
  goal: ThreadGoalState | null,
  input: { readonly dismissedGoalId: string | null; readonly latestTurnId: string | null },
): goal is ThreadGoalState {
  if (!goal) return false;
  if (goal.status === "active") return true;
  if (goal.goalId === input.dismissedGoalId) return false;
  return goal.lastTurnId === null || goal.lastTurnId === input.latestTurnId;
}
