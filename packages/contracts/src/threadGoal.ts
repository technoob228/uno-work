import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

export const THREAD_GOAL_MAX_LENGTH = 500;
/** The activity that carries a goal's state to clients. */
export const THREAD_GOAL_ACTIVITY_KIND = "goal.updated";

/**
 * `active`: the agent keeps taking turns. The rest are the ends: `met` and
 * `blocked` are the agent's word, `limit` a ceiling, `stopped` the person,
 * `failed` the agent could not go on.
 */
export const ThreadGoalStatus = Schema.Literals([
  "active",
  "met",
  "blocked",
  "limit",
  "stopped",
  "failed",
]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoalState = Schema.Struct({
  goalId: TrimmedNonEmptyString,
  goal: TrimmedNonEmptyString,
  status: ThreadGoalStatus,
  turnsUsed: Schema.Int,
  maxTurns: Schema.Int,
  /** What the provider reported; null when it reports no cost (Codex, OpenCode). */
  costUsd: Schema.NullOr(Schema.Number),
  maxCostUsd: Schema.Number,
  startedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  /** A line for the person, once it ended. */
  endNote: Schema.NullOr(Schema.String),
  /** The turn it last looked at. */
  lastTurnId: Schema.NullOr(TurnId),
});
export type ThreadGoalState = typeof ThreadGoalState.Type;

export const OrchestrationSetThreadGoalInput = Schema.Struct({
  threadId: ThreadId,
  goal: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_GOAL_MAX_LENGTH)),
});
export type OrchestrationSetThreadGoalInput = typeof OrchestrationSetThreadGoalInput.Type;

export const OrchestrationStopThreadGoalInput = Schema.Struct({ threadId: ThreadId });
export type OrchestrationStopThreadGoalInput = typeof OrchestrationStopThreadGoalInput.Type;

export const OrchestrationStopThreadGoalResult = Schema.Struct({ stopped: Schema.Boolean });
export type OrchestrationStopThreadGoalResult = typeof OrchestrationStopThreadGoalResult.Type;

export class OrchestrationThreadGoalError extends Schema.TaggedErrorClass<OrchestrationThreadGoalError>()(
  "OrchestrationThreadGoalError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
