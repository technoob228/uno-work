/**
 * Moving through setup: every move is recorded (visited / skipped) and the
 * route changes at once. The record is applied locally right away (the
 * optimistic settings copy); the machine's write finishes in the background —
 * the returned promise settles with it.
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
    (step: SetupStepId): Promise<void> => {
      // Сначала переход, сохранение фоном (perf/ttfa-startup): ждать записи
      // настроек на стартующем демоне — это и были 3 с после «Skip setup».
      const saved = update((current) => markCompleted(current, step));
      // The goal-first start sent the person to sign in to their own AI:
      // back to the goal's result, not on through the old eight steps.
      const goal = goalState(progress);
      if (step === "ai" && goal.goal && goal.path === "own_subscription") {
        void navigate({
          to: "/setup",
          search: { step: "welcome", goal: goal.goal, via: "own_subscription" },
        });
        return saved;
      }
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
      return saved;
    },
    [goHome, goToStep, navigate, progress, update],
  );

  const skipStep = useCallback(
    (step: SetupStepId): Promise<void> => {
      const saved = update((current) => markSkipped(current, step));
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
      return saved;
    },
    [goHome, goToStep, update],
  );

  const skipAll = useCallback((): Promise<void> => {
    const saved = update((current) => skipRemaining({ ...current, mode: current.mode ?? "ai" }));
    goHome();
    return saved;
  }, [goHome, update]);

  return { goToStep, goHome, completeStep, skipStep, skipAll };
}
