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
 * Browser flow: after the welcome the user picks where to work (the Uno cloud
 * box or their own computer); the rest is about what this thing is and getting
 * the first project onto the machine.
 */
export const WEB_ONBOARDING_STEP_IDS = [
  "web-welcome",
  "web-where",
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

export type OnboardingFlow = "desktop" | "web";

/** Where the browser user chose to keep files and run agents. */
export type OnboardingWorkLocation = "cloud" | "local";

/**
 * Users who work on their own computer are never introduced to the cloud box,
 * so that step drops out once they pick "local". Every other step stays and
 * keeps targeting the primary environment.
 */
export function resolveWebOnboardingStepIds(
  workLocation: OnboardingWorkLocation | null,
): ReadonlyArray<OnboardingStepId> {
  if (workLocation !== "local") return WEB_ONBOARDING_STEP_IDS;
  return WEB_ONBOARDING_STEP_IDS.filter((stepId) => stepId !== "web-machine");
}

export function resolveOnboardingStepIds(
  flow: OnboardingFlow,
  workLocation: OnboardingWorkLocation | null,
): ReadonlyArray<OnboardingStepId> {
  return flow === "web" ? resolveWebOnboardingStepIds(workLocation) : DESKTOP_ONBOARDING_STEP_IDS;
}

export interface OnboardingState {
  stepIndex: number;
  stepId: OnboardingStepId;
  totalSteps: number;
  progressPercent: number;
  isFirst: boolean;
  isLast: boolean;
  /** Browser flow only; `null` until the user picks on the "web-where" step. */
  workLocation: OnboardingWorkLocation | null;
  setWorkLocation: (workLocation: OnboardingWorkLocation) => void;
  next: () => void;
  back: () => void;
  goTo: (stepId: OnboardingStepId) => void;
}

export function useOnboardingState(flow: OnboardingFlow = "desktop"): OnboardingState {
  const [stepIndex, setStepIndex] = useState(0);
  const [workLocation, setWorkLocation] = useState<OnboardingWorkLocation | null>(null);
  const stepIds = useMemo(() => resolveOnboardingStepIds(flow, workLocation), [flow, workLocation]);

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
    // The step list can shrink after a choice; never point past its end.
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
      workLocation,
      setWorkLocation,
      next,
      back,
      goTo,
    };
  }, [stepIndex, stepIds, workLocation, next, back, goTo]);
}
