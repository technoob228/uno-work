import { GOAL_MAX_MINUTES } from "@t3tools/shared/threadGoal";
import type { ThreadGoalState } from "@t3tools/contracts";
import { TargetIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";

function goalProgressLine(goal: ThreadGoalState): string {
  const cost = goal.costUsd === null ? [] : [`$${goal.costUsd.toFixed(2)} of $${goal.maxCostUsd}`];
  return [
    `Turn ${goal.turnsUsed} of ${goal.maxTurns}`,
    ...cost,
    `${GOAL_MAX_MINUTES} min max`,
  ].join(" · ");
}

/** The goal the chat is working on: what, how far, and a way out. */
export function ThreadGoalBar(props: {
  readonly goal: ThreadGoalState;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onDismiss: () => void;
}) {
  const { goal } = props;
  const active = goal.status === "active";
  return (
    <div
      data-testid="thread-goal-bar"
      data-goal-status={goal.status}
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
    >
      <TargetIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={goal.goal}>
          {goal.goal}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {active ? goalProgressLine(goal) : goal.endNote}
        </span>
      </div>
      {active ? (
        <Button size="xs" variant="outline" disabled={props.stopping} onClick={props.onStop}>
          Stop
        </Button>
      ) : (
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={props.onDismiss}>
          <XIcon />
        </Button>
      )}
    </div>
  );
}
