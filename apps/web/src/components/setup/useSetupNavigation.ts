/**
 * Moving through setup: every move is recorded on the machine first
 * (visited / skipped), then the route changes.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
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
  const machine = useActiveMachine();

  const goToStep = useCallback(
    (step: SetupRouteStep) => {
      void navigate({ to: "/setup", search: { step } });
    },
    [navigate],
  );

  /** Home: the computer's desktop on a cloud machine, the last chat elsewhere. */
  const goHome = useCallback(() => {
    void navigate({ to: machine.isCloud ? "/computer" : "/" });
  }, [machine.isCloud, navigate]);

  const completeStep = useCallback(
    async (step: SetupStepId) => {
      await update((current) => markCompleted(current, step));
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
    },
    [goHome, goToStep, update],
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
