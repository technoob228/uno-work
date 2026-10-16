/**
 * Moving through setup: every move is recorded (visited / skipped) and the
 * route changes at once. The record is applied locally right away (the
 * optimistic settings copy); the machine's write finishes in the background —
 * the returned promise settles with it.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { trackFunnel } from "../../lib/funnel";
import { nextStepIdForSetupStep } from "../computer/home/agentStart";
import { nextStepDoneKey } from "../computer/home/nextStep";

import {
  markCompleted,
  markSkipped,
  nextStep,
  skipRemaining,
  type SetupRouteStep,
  type SetupStepId,
} from "./setupModel";
import { goalState, withAnswer } from "./goals";
import { useSetupProgress, useUpdateSetupProgress } from "./useSetupProgress";

export function useSetupNavigation() {
  const navigate = useNavigate();
  const update = useUpdateSetupProgress();
  const progress = useSetupProgress();
  // A step opened on its own from Home's Next step card (`one=1`).
  const one = useSearch({ strict: false, select: (search) => search.one === true });

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
      const nextStepId = one ? nextStepIdForSetupStep(step) : null;
      if (one) {
        // Done: the card moves on here at once, and the account hears it now —
        // on finishing, not on the click that opened it (fishcode next-step).
        const saved = update((current) => {
          const completed = markCompleted(current, step);
          return nextStepId
            ? withAnswer(completed, nextStepDoneKey(nextStepId), new Date().toISOString())
            : completed;
        });
        if (nextStepId) {
          trackFunnel("next_step_clicked", {
            goal: goalState(progress).goal,
            props: { step_id: nextStepId },
          });
        }
        goHome();
        return saved;
      }
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
    [goHome, goToStep, navigate, one, progress, update],
  );

  const skipStep = useCallback(
    (step: SetupStepId): Promise<void> => {
      // On its own: Skip is "not now" — back to Home, the step stays open there.
      if (one) {
        goHome();
        return Promise.resolve();
      }
      const saved = update((current) => markSkipped(current, step));
      const next = nextStep(step);
      if (next) goToStep(next);
      else goHome();
      return saved;
    },
    [goHome, goToStep, one, update],
  );

  const skipAll = useCallback((): Promise<void> => {
    const saved = update((current) => skipRemaining({ ...current, mode: current.mode ?? "ai" }));
    goHome();
    return saved;
  }, [goHome, update]);

  return { goToStep, goHome, completeStep, skipStep, skipAll, one };
}
