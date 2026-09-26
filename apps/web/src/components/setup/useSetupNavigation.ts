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
import { useUpdateSetupProgress } from "./useSetupProgress";

export function useSetupNavigation() {
  const navigate = useNavigate();
  const update = useUpdateSetupProgress();

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
      const saved = update((current) => markCompleted(current, step));
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
      return saved;
    },
    [goHome, goToStep, update],
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
