import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerConfig } from "../rpc/serverState";
import { useCallback, useEffect, useRef } from "react";

import { OnboardingShell } from "~/components/onboarding/OnboardingShell";
import { useFirstChatLaunch } from "~/components/onboarding/useFirstChatLaunch";
import { useOnboardingState } from "~/components/onboarding/useOnboardingState";
import { DevModeStep } from "~/components/onboarding/steps/DevModeStep";
import { HarnessesStep } from "~/components/onboarding/steps/HarnessesStep";
import { PermissionsStep } from "~/components/onboarding/steps/PermissionsStep";
import { RulesStep } from "~/components/onboarding/steps/RulesStep";
import { UnoLlmStep } from "~/components/onboarding/steps/UnoLlmStep";
import { ConnectAgentStep } from "~/components/onboarding/steps/ConnectAgentStep";
import { PathStep } from "~/components/onboarding/steps/PathStep";
import { SshAccessStep } from "~/components/onboarding/steps/SshAccessStep";
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
  const flow = isWebApp ? "web" : "desktop";
  const state = useOnboardingState(flow);
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const openAddProjectRef = useRef(false);

  const markCompleted = useCallback(() => {
    void updateSettings({ onboardingCompleted: true, machineOnboarded: true });
  }, [updateSettings]);

  // In the browser flow the last step opens a real chat itself; completion is
  // recorded just before that navigation so the root guard lets it through.
  const firstChat = useFirstChatLaunch({ onBeforeNavigate: markCompleted });

  // Setup is remembered per machine too: the same computer opened from another
  // address or device (its own localStorage) goes straight in.
  const machineOnboarded = useServerConfig()?.settings.machineOnboarded === true;
  useEffect(() => {
    if (!machineOnboarded) return;
    void updateSettings({ onboardingCompleted: true });
    void navigate({ to: "/", replace: true });
  }, [machineOnboarded, navigate, updateSettings]);

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
    // The agent and SSH paths end in the normal app: nothing is locked by the
    // choice, Uno Work is simply there when the person wants it.
    if (state.path !== "work") {
      handleSkip();
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

  const continueLabel =
    state.stepId === "agent-connect"
      ? "Done — open Uno Work anyway"
      : state.stepId === "ssh-access"
        ? "Done — open Uno Work"
        : isWebApp && state.isLast
          ? "Open my computer"
          : undefined;
  const continueLabelProps = continueLabel ? { continueLabel } : {};

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
      {state.stepId === "path" && (
        <PathStep
          flow={flow}
          value={state.path}
          onChange={state.setPath}
          onConfirm={state.next}
        />
      )}
      {state.stepId === "agent-connect" && <ConnectAgentStep />}
      {state.stepId === "ssh-access" && (
        <SshAccessStep flow={flow} onContinueInUnoWork={() => state.setPath("work")} />
      )}
      {state.stepId === "perms" && <PermissionsStep />}
      {state.stepId === "what" && <WhatItDoesStep />}
      {state.stepId === "dev" && <DevModeStep />}
      {state.stepId === "harness" && <HarnessesStep />}
      {state.stepId === "unollm" && <UnoLlmStep />}
      {state.stepId === "rules" && <RulesStep />}
      {state.stepId === "web-computer" && (
        <ComputerHelloStep
          onOpenComputer={() => {
            markCompleted();
            void navigate({ to: "/computer", replace: true });
          }}
        />
      )}
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
