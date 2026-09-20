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
 * Browser flow: the tab is already connected to a provisioned machine, so
 * there is nothing to install or choose. Three screens: this is your computer,
 * it works while you're away, now ask it for something — the last one ends in
 * a real chat rather than a settings page.
 */
export const WEB_ONBOARDING_STEP_IDS = ["web-computer", "web-away", "web-chat"] as const;

/** Kept as the default export name for the desktop flow and its tests. */
export const ONBOARDING_STEP_IDS = DESKTOP_ONBOARDING_STEP_IDS;

export type OnboardingStepId =
  | (typeof DESKTOP_ONBOARDING_STEP_IDS)[number]
  | (typeof WEB_ONBOARDING_STEP_IDS)[number];

export type OnboardingFlow = "desktop" | "web";

export function resolveOnboardingStepIds(flow: OnboardingFlow): ReadonlyArray<OnboardingStepId> {
  return flow === "web" ? WEB_ONBOARDING_STEP_IDS : DESKTOP_ONBOARDING_STEP_IDS;
}

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

export function useOnboardingState(flow: OnboardingFlow = "desktop"): OnboardingState {
  const [stepIndex, setStepIndex] = useState(0);
  const stepIds = useMemo(() => resolveOnboardingStepIds(flow), [flow]);

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
    const boundedIndex = Math.min(stepIndex, stepIds.length - 1);
    const stepId = stepIds[boundedIndex] ?? stepIds[0] ?? "welcome";
    const total = stepIds.length;
    return {
      stepIndex: boundedIndex,
      stepId,
      totalSteps: total,
      progressPercent: ((boundedIndex + 1) / total) * 100,
      isFirst: boundedIndex === 0,
      isLast: boundedIndex === total - 1,
      next,
      back,
      goTo,
    };
  }, [stepIndex, stepIds, next, back, goTo]);
}
