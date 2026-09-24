import { createFileRoute } from "@tanstack/react-router";

import { SetupView } from "../components/setup/SetupView";
import { parseSetupRouteStep, type SetupRouteStep } from "../components/setup/setupModel";

export interface SetupRouteSearch {
  /** One of the eight steps, or the tour's closing screen. Defaults to the first step. */
  readonly step: SetupRouteStep;
}

export const Route = createFileRoute("/_chat/setup")({
  validateSearch: (search: Record<string, unknown>): SetupRouteSearch => ({
    step: parseSetupRouteStep(search["step"]) ?? "ai",
  }),
  component: SetupView,
});
