import { useCallback, useMemo, useState } from "react";

export const ONBOARDING_STEP_IDS = [
  "welcome",
  "perms",
  "what",
  "dev",
  "harness",
  "unollm",
  "rules",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

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

export function useOnboardingState(): OnboardingState {
  const [stepIndex, setStepIndex] = useState(0);

  const next = useCallback(() => {
    setStepIndex((current) => Math.min(current + 1, ONBOARDING_STEP_IDS.length - 1));
  }, []);

  const back = useCallback(() => {
    setStepIndex((current) => Math.max(current - 1, 0));
  }, []);

  const goTo = useCallback((stepId: OnboardingStepId) => {
    const index = ONBOARDING_STEP_IDS.indexOf(stepId);
    if (index >= 0) setStepIndex(index);
  }, []);

  return useMemo(() => {
    const stepId = ONBOARDING_STEP_IDS[stepIndex] ?? "welcome";
    const total = ONBOARDING_STEP_IDS.length;
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
  }, [stepIndex, next, back, goTo]);
}
