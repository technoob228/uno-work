import { createFileRoute } from "@tanstack/react-router";

import { SetupView } from "../components/setup/SetupView";
import { parseSetupRouteStep, type SetupRouteStep } from "../components/setup/setupModel";
import {
  parseConnectPath,
  parseGoal,
  type ConnectPath,
  type GoalId,
} from "../components/setup/goals";

export interface SetupRouteSearch {
  /** One of the eight steps, or the tour's closing screen. Defaults to the first step. */
  readonly step: SetupRouteStep;
  /** The goal-first start (`step=welcome`): the picked goal. */
  readonly goal?: GoalId;
  /** The goal-first start: how the person works (screen 2's answer). */
  readonly via?: ConnectPath;
}

export const Route = createFileRoute("/_chat/setup")({
  validateSearch: (search: Record<string, unknown>): SetupRouteSearch => {
    const goal = parseGoal(search["goal"]);
    const via = parseConnectPath(search["via"]);
    return {
      step: parseSetupRouteStep(search["step"]) ?? "ai",
      ...(goal ? { goal } : {}),
      ...(via ? { via } : {}),
    };
  },
  component: SetupView,
});
