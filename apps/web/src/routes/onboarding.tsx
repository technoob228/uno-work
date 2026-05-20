import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { OnboardingShell } from "~/components/onboarding/OnboardingShell";
import { useOnboardingState } from "~/components/onboarding/useOnboardingState";
import { DevModeStep } from "~/components/onboarding/steps/DevModeStep";
import { HarnessesStep } from "~/components/onboarding/steps/HarnessesStep";
import { PermissionsStep } from "~/components/onboarding/steps/PermissionsStep";
import { RulesStep } from "~/components/onboarding/steps/RulesStep";
import { UnoLlmStep } from "~/components/onboarding/steps/UnoLlmStep";
import { WelcomeStep } from "~/components/onboarding/steps/WelcomeStep";
import { WhatItDoesStep } from "~/components/onboarding/steps/WhatItDoesStep";
import { useCommandPaletteStore } from "~/commandPaletteStore";
import { ensureClientSettingsHydrated, useUpdateSettings } from "~/hooks/useSettings";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/", replace: true });
    }
    await ensureClientSettingsHydrated();
  },
  component: OnboardingRouteView,
});

function OnboardingRouteView() {
  const state = useOnboardingState();
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const openAddProjectRef = useRef(false);

  useEffect(() => {
    return () => {
      if (openAddProjectRef.current) {
        const open = useCommandPaletteStore.getState().openAddProject;
        Promise.resolve().then(() => open());
      }
    };
  }, []);

  const finishAndOpenProjectPicker = () => {
    updateSettings({ onboardingCompleted: true });
    openAddProjectRef.current = true;
    void navigate({ to: "/", replace: true });
  };

  const handleContinue = () => {
    if (state.isLast) {
      finishAndOpenProjectPicker();
      return;
    }
    state.next();
  };

  const handleSkip = () => {
    updateSettings({ onboardingCompleted: true });
    void navigate({ to: "/", replace: true });
  };

  return (
    <OnboardingShell
      stepId={state.stepId}
      stepIndex={state.stepIndex}
      totalSteps={state.totalSteps}
      progressPercent={state.progressPercent}
      isFirst={state.isFirst}
      isLast={state.isLast}
      onBack={state.back}
      onContinue={handleContinue}
      onSkip={handleSkip}
    >
      {state.stepId === "welcome" && <WelcomeStep />}
      {state.stepId === "perms" && <PermissionsStep />}
      {state.stepId === "what" && <WhatItDoesStep />}
      {state.stepId === "dev" && <DevModeStep />}
      {state.stepId === "harness" && <HarnessesStep />}
      {state.stepId === "unollm" && <UnoLlmStep />}
      {state.stepId === "rules" && <RulesStep />}
    </OnboardingShell>
  );
}
