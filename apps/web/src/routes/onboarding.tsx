import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { OnboardingShell } from "~/components/onboarding/OnboardingShell";
import { useFirstChatLaunch } from "~/components/onboarding/useFirstChatLaunch";
import { useOnboardingState } from "~/components/onboarding/useOnboardingState";
import { DevModeStep } from "~/components/onboarding/steps/DevModeStep";
import { HarnessesStep } from "~/components/onboarding/steps/HarnessesStep";
import { PermissionsStep } from "~/components/onboarding/steps/PermissionsStep";
import { RulesStep } from "~/components/onboarding/steps/RulesStep";
import { UnoLlmStep } from "~/components/onboarding/steps/UnoLlmStep";
import { WelcomeStep } from "~/components/onboarding/steps/WelcomeStep";
import { WhatItDoesStep } from "~/components/onboarding/steps/WhatItDoesStep";
import { ComputerAwayStep } from "~/components/onboarding/steps/web/ComputerAwayStep";
import { ComputerChatStep } from "~/components/onboarding/steps/web/ComputerChatStep";
import { ComputerHelloStep } from "~/components/onboarding/steps/web/ComputerHelloStep";
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

  const markCompleted = useCallback(() => {
    void updateSettings({ onboardingCompleted: true });
  }, [updateSettings]);

  // In the browser flow the last step opens a real chat itself; completion is
  // recorded just before that navigation so the root guard lets it through.
  const firstChat = useFirstChatLaunch({ onBeforeNavigate: markCompleted });

  useEffect(() => {
    return () => {
      if (openAddProjectRef.current) {
        const open = useCommandPaletteStore.getState().openAddProject;
        Promise.resolve().then(() => open());
      }
    };
  }, []);

  const finish = (openProjectPicker: boolean) => {
    markCompleted();
    openAddProjectRef.current = openProjectPicker;
    void navigate({ to: "/", replace: true });
  };

  const handleContinue = () => {
    if (!state.isLast) {
      state.next();
      return;
    }
    if (isWebApp) {
      // Same path as the suggestion chips, just without a pre-filled message.
      void firstChat.launch(null);
      return;
    }
    finish(true);
  };

  const handleSkip = () => {
    markCompleted();
    void navigate({ to: "/", replace: true });
  };

  const continueLabelProps = isWebApp && state.isLast ? { continueLabel: "Open my computer" } : {};

  return (
    <OnboardingShell
      stepId={state.stepId}
      stepIndex={state.stepIndex}
      totalSteps={state.totalSteps}
      progressPercent={state.progressPercent}
      isFirst={state.isFirst}
      isLast={state.isLast}
      canContinue={!firstChat.pending}
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
      {state.stepId === "web-computer" && <ComputerHelloStep />}
      {state.stepId === "web-away" && <ComputerAwayStep />}
      {state.stepId === "web-chat" && (
        <ComputerChatStep
          pending={firstChat.pending}
          error={firstChat.error}
          onPick={(prompt) => void firstChat.launch(prompt)}
        />
      )}
    </OnboardingShell>
  );
}
