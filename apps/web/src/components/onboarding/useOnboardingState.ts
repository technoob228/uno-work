import { useCallback, useMemo, useState } from "react";

import { type OnboardingPath, readOnboardingPath, writeOnboardingPath } from "./onboardingPath";

export type { OnboardingPath } from "./onboardingPath";

/**
 * Desktop flow, "In Uno Work": permissions, harness installs and other
 * local-machine setup. The old separate welcome screen is folded into the
 * first "How do you want to use Uno?" screen, which greets the person itself.
 */
export const DESKTOP_ONBOARDING_STEP_IDS = [
  "path",
  "perms",
  "what",
  "dev",
  "harness",
  "unollm",
  "rules",
] as const;

/**
 * Browser flow, "In Uno Work": the tab is already connected to a provisioned
 * machine, so there is nothing to install. After the path choice, three
 * screens: this is your computer, it works while you're away, now ask it for
 * something — the last one ends in a real chat rather than a settings page.
 */
export const WEB_ONBOARDING_STEP_IDS = ["path", "web-computer", "web-away", "web-chat"] as const;

/** "With my own AI agent": one screen on how to connect it, then the app. */
export const AGENT_ONBOARDING_STEP_IDS = ["path", "agent-connect"] as const;

/** "Over SSH": one screen with this computer's SSH address (or how to get one). */
export const SSH_ONBOARDING_STEP_IDS = ["path", "ssh-access"] as const;

/** Kept as the default export name for the desktop flow and its tests. */
export const ONBOARDING_STEP_IDS = DESKTOP_ONBOARDING_STEP_IDS;

export type OnboardingStepId =
  | (typeof DESKTOP_ONBOARDING_STEP_IDS)[number]
  | (typeof WEB_ONBOARDING_STEP_IDS)[number]
  | (typeof AGENT_ONBOARDING_STEP_IDS)[number]
  | (typeof SSH_ONBOARDING_STEP_IDS)[number];

export type OnboardingFlow = "desktop" | "web";

export function resolveOnboardingStepIds(
  flow: OnboardingFlow,
  path: OnboardingPath = "work",
): ReadonlyArray<OnboardingStepId> {
  if (path === "agent") return AGENT_ONBOARDING_STEP_IDS;
  if (path === "ssh") return SSH_ONBOARDING_STEP_IDS;
  return flow === "web" ? WEB_ONBOARDING_STEP_IDS : DESKTOP_ONBOARDING_STEP_IDS;
}

export interface OnboardingState {
  stepIndex: number;
  stepId: OnboardingStepId;
  totalSteps: number;
  progressPercent: number;
  isFirst: boolean;
  isLast: boolean;
  /** How the person chose to use Uno on the first screen ("work" until they pick). */
  path: OnboardingPath;
  setPath: (path: OnboardingPath) => void;
  next: () => void;
  back: () => void;
  goTo: (stepId: OnboardingStepId) => void;
}

export function useOnboardingState(flow: OnboardingFlow = "desktop"): OnboardingState {
  const [stepIndex, setStepIndex] = useState(0);
  // Onboarding always opens on the path screen with "In Uno Work" selected; a
  // choice remembered from an earlier, unfinished run is offered again.
  const [path, setPathState] = useState<OnboardingPath>(() => readOnboardingPath() ?? "work");
  const stepIds = useMemo(() => resolveOnboardingStepIds(flow, path), [flow, path]);

  const setPath = useCallback((nextPath: OnboardingPath) => {
    setPathState(nextPath);
    writeOnboardingPath(nextPath);
  }, []);

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
    const stepId = stepIds[boundedIndex] ?? stepIds[0] ?? "path";
    const total = stepIds.length;
    return {
      stepIndex: boundedIndex,
      stepId,
      totalSteps: total,
      progressPercent: ((boundedIndex + 1) / total) * 100,
      isFirst: boundedIndex === 0,
      isLast: boundedIndex === total - 1,
      path,
      setPath,
      next,
      back,
      goTo,
    };
  }, [stepIndex, stepIds, path, setPath, next, back, goTo]);
}
