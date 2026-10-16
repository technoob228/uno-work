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
  /**
   * One step on its own (`one=1`): Home's Next step card opened it (the agent
   * on a server, flow-agent 15.10). Continue / Skip go back to Home instead of
   * on through the eight steps; no step strip, no "Skip setup".
   */
  readonly one?: true;
}

export const Route = createFileRoute("/_chat/setup")({
  validateSearch: (search: Record<string, unknown>): SetupRouteSearch => {
    const goal = parseGoal(search["goal"]);
    const via = parseConnectPath(search["via"]);
    return {
      step: parseSetupRouteStep(search["step"]) ?? "ai",
      ...(goal ? { goal } : {}),
      ...(via ? { via } : {}),
      ...(search["one"] === 1 || search["one"] === "1" || search["one"] === true
        ? { one: true as const }
        : {}),
    };
  },
  component: SetupView,
});
