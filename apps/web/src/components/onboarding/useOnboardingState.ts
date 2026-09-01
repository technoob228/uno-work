import { useCallback, useMemo, useState } from "react";

/** Desktop flow: permissions, harness installs and other local-machine setup. */
export const DESKTOP_ONBOARDING_STEP_IDS = [
  "welcome",
  "perms",
  "what",
  "dev",
  "harness",
  "unollm",
  "rules",
] as const;

/**
 * Browser flow: the machine is already provisioned, so setup is about what this
 * thing is and getting the first project onto it.
 */
export const WEB_ONBOARDING_STEP_IDS = [
  "web-welcome",
  "what",
  "web-machine",
  "web-harness",
  "unollm",
  "web-first-project",
] as const;

/** Kept as the default export name for the desktop flow and its tests. */
export const ONBOARDING_STEP_IDS = DESKTOP_ONBOARDING_STEP_IDS;

export type OnboardingStepId =
  | (typeof DESKTOP_ONBOARDING_STEP_IDS)[number]
  | (typeof WEB_ONBOARDING_STEP_IDS)[number];

export interface OnboardingState {
  stepIndex: number;
  stepId: OnboardingStepId;
  totalSteps: number;
  progressPercent: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  back: () => void;
  goTo: (stepId: OnboardingStepId) => void;
}

export function useOnboardingState(
  stepIds: ReadonlyArray<OnboardingStepId> = DESKTOP_ONBOARDING_STEP_IDS,
): OnboardingState {
  const [stepIndex, setStepIndex] = useState(0);

  const next = useCallback(() => {
    setStepIndex((current) => Math.min(current + 1, stepIds.length - 1));
  }, [stepIds.length]);

  const back = useCallback(() => {
    setStepIndex((current) => Math.max(current - 1, 0));
  }, []);

  const goTo = useCallback(
    (stepId: OnboardingStepId) => {
      const index = stepIds.indexOf(stepId);
      if (index >= 0) setStepIndex(index);
    },
    [stepIds],
  );

  return useMemo(() => {
    const stepId = stepIds[stepIndex] ?? stepIds[0] ?? "welcome";
    const total = stepIds.length;
    return {
      stepIndex,
      stepId,
      totalSteps: total,
      progressPercent: ((stepIndex + 1) / total) * 100,
      isFirst: stepIndex === 0,
      isLast: stepIndex === total - 1,
      next,
      back,
      goTo,
    };
  }, [stepIndex, stepIds, next, back, goTo]);
}
