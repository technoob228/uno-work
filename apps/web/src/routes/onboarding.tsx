import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { OnboardingShell } from "~/components/onboarding/OnboardingShell";
import { useOnboardingState } from "~/components/onboarding/useOnboardingState";
import { DevModeStep } from "~/components/onboarding/steps/DevModeStep";
import { HarnessesStep } from "~/components/onboarding/steps/HarnessesStep";
import { PermissionsStep } from "~/components/onboarding/steps/PermissionsStep";
import { RulesStep } from "~/components/onboarding/steps/RulesStep";
import { UnoLlmStep } from "~/components/onboarding/steps/UnoLlmStep";
import { WelcomeStep } from "~/components/onboarding/steps/WelcomeStep";
import { WhatItDoesStep } from "~/components/onboarding/steps/WhatItDoesStep";
import { FirstProjectStep } from "~/components/onboarding/steps/web/FirstProjectStep";
import { WebHarnessesStep } from "~/components/onboarding/steps/web/WebHarnessesStep";
import { WebMachineStep } from "~/components/onboarding/steps/web/WebMachineStep";
import { WebWelcomeStep } from "~/components/onboarding/steps/web/WebWelcomeStep";
import { WebWhereStep } from "~/components/onboarding/steps/web/WebWhereStep";
import { useCommandPaletteStore } from "~/commandPaletteStore";
import { ensureClientSettingsHydrated, useUpdateSettings } from "~/hooks/useSettings";
import { isWebApp } from "~/webMode";

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
  const state = useOnboardingState(isWebApp ? "web" : "desktop");
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const openAddProjectRef = useRef(false);
  // In the browser flow the last step creates the project itself, so finishing
  // must not reopen the desktop folder picker.
  const [webProjectCreated, setWebProjectCreated] = useState(false);

  useEffect(() => {
    return () => {
      if (openAddProjectRef.current) {
        const open = useCommandPaletteStore.getState().openAddProject;
        Promise.resolve().then(() => open());
      }
    };
  }, []);

  const finish = (openProjectPicker: boolean) => {
    void updateSettings({ onboardingCompleted: true });
    openAddProjectRef.current = openProjectPicker;
    void navigate({ to: "/", replace: true });
  };

  const handleContinue = () => {
    if (!state.isLast) {
      state.next();
      return;
    }
    finish(!isWebApp);
  };

  const handleSkip = () => {
    void updateSettings({ onboardingCompleted: true });
    void navigate({ to: "/", replace: true });
  };

  const continueLabelProps = isWebApp
    ? {
        continueLabel: state.isLast
          ? webProjectCreated
            ? "Open project"
            : "Skip for now"
          : "Continue",
      }
    : {};

  return (
    <OnboardingShell
      stepId={state.stepId}
      stepIndex={state.stepIndex}
      totalSteps={state.totalSteps}
      progressPercent={state.progressPercent}
      isFirst={state.isFirst}
      isLast={state.isLast}
      // The "where" step is a real decision: no default, so Continue waits for it.
      canContinue={state.stepId !== "web-where" || state.workLocation !== null}
      {...continueLabelProps}
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
      {state.stepId === "web-welcome" && <WebWelcomeStep />}
      {state.stepId === "web-where" && (
        <WebWhereStep workLocation={state.workLocation} onSelect={state.setWorkLocation} />
      )}
      {state.stepId === "web-machine" && <WebMachineStep />}
      {state.stepId === "web-harness" && <WebHarnessesStep />}
      {state.stepId === "web-first-project" && (
        <FirstProjectStep onProjectReady={() => setWebProjectCreated(true)} />
      )}
    </OnboardingShell>
  );
}
