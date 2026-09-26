/**
 * Moving through setup: every move is recorded on the machine first
 * (visited / skipped), then the route changes.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  markCompleted,
  markSkipped,
  nextStep,
  skipRemaining,
  type SetupRouteStep,
  type SetupStepId,
} from "./setupModel";
import { goalState } from "./goals";
import { useSetupProgress, useUpdateSetupProgress } from "./useSetupProgress";

export function useSetupNavigation() {
  const navigate = useNavigate();
  const update = useUpdateSetupProgress();
  const progress = useSetupProgress();

  const goToStep = useCallback(
    (step: SetupRouteStep) => {
      void navigate({ to: "/setup", search: { step } });
    },
    [navigate],
  );

  /** Home (the computer's desktop), on every machine — the sidebar's Home row. */
  const goHome = useCallback(() => {
    void navigate({ to: "/computer" });
  }, [navigate]);

  const completeStep = useCallback(
    async (step: SetupStepId) => {
      await update((current) => markCompleted(current, step));
      // The goal-first start sent the person to sign in to their own AI:
      // back to the goal's result, not on through the old eight steps.
      const goal = goalState(progress);
      if (step === "ai" && goal.goal && goal.path === "own_subscription") {
        void navigate({
          to: "/setup",
          search: { step: "welcome", goal: goal.goal, via: "own_subscription" },
        });
        return;
      }
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
    },
    [goHome, goToStep, navigate, progress, update],
  );

  const skipStep = useCallback(
    async (step: SetupStepId) => {
      await update((current) => markSkipped(current, step));
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
    },
    [goHome, goToStep, update],
  );

  const skipAll = useCallback(async () => {
    await update((current) => skipRemaining({ ...current, mode: current.mode ?? "ai" }));
    goHome();
  }, [goHome, update]);

  return { goToStep, goHome, completeStep, skipStep, skipAll };
}
