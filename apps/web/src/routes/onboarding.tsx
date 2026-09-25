import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerConfig } from "../rpc/serverState";
import { useCallback, useEffect, useRef, useState } from "react";

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
import {
  WorkWelcomeStep,
  type WelcomeMode,
} from "~/components/onboarding/steps/web/WorkWelcomeStep";
import { OwnToolsDialog, type OwnToolsTab } from "~/components/setup/OwnToolsDialog";
import { skipRemaining } from "~/components/setup/setupModel";
import { useStartSetupTour } from "~/components/setup/SetupTour";
import { useUpdateSetupProgress } from "~/components/setup/useSetupProgress";
import { useCommandPaletteStore } from "~/commandPaletteStore";
import { ensureClientSettingsHydrated, useUpdateSettings } from "~/hooks/useSettings";
import { isWebApp } from "~/webMode";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/", replace: true });
    }
    // The browser's welcome is a step of the in-app setup.
    if (isWebApp) throw redirect({ to: "/setup", search: { step: "welcome" }, replace: true });
    await ensureClientSettingsHydrated();
  },
  component: OnboardingRouteView,
});

function OnboardingRouteView() {
  const state = useOnboardingState(isWebApp ? "web" : "desktop");
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const openAddProjectRef = useRef(false);

  const updateSetup = useUpdateSetupProgress();
  const markCompleted = useCallback(async () => {
    await updateSettings({ onboardingCompleted: true, machineOnboarded: true });
    // The desktop flow sets up the machine itself; the guided setup (AI,
    // project, AGENTS.md, skills…) then waits as "Set up 0/8" in the sidebar.
    if (!isWebApp)
      await updateSetup((current) => (current.mode ? current : { ...current, mode: "ai" }));
  }, [updateSettings, updateSetup]);
  const startTour = useStartSetupTour();
  const [welcomeMode, setWelcomeMode] = useState<WelcomeMode>("ai");
  const [ownTools, setOwnTools] = useState<OwnToolsTab | null>(null);
  const [leaving, setLeaving] = useState(false);

  // Browser: the welcome screen hands over to the tour or the guided setup,
  // both inside the app. Completion is saved first so the root guard lets the
  // navigation through.
  const leaveWelcome = async (mode: WelcomeMode) => {
    if (leaving) return;
    setLeaving(true);
    try {
      await markCompleted();
      await updateSetup((current) => ({ ...current, mode }));
      if (mode === "simple") startTour("home");
      else void navigate({ to: "/setup", search: { step: "ai" } });
    } finally {
      setLeaving(false);
    }
  };

  // In the browser flow the last step opens a real chat itself; completion is
  // recorded just before that navigation so the root guard lets it through.
  const firstChat = useFirstChatLaunch({
    onBeforeNavigate: () => {
      void markCompleted();
    },
  });

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
    void markCompleted();
    openAddProjectRef.current = openProjectPicker;
    void navigate({ to: "/", replace: true });
  };

  const handleContinue = () => {
    if (isWebApp) {
      void leaveWelcome(welcomeMode);
      return;
    }
    if (!state.isLast) {
      state.next();
      return;
    }
    // Both flows end in a new chat in the home folder (a starter project on a
    // machine without projects; the chat's folder chip picks another). The
    // desktop falls back to the old folder picker if that can't be opened.
    void firstChat.launch(null).then((opened) => {
      if (!opened && !isWebApp) finish(true);
    });
  };

  const handleSkip = () => {
    void (async () => {
      await markCompleted();
      // The browser's guided setup stays one click away: "Finish setup" in the sidebar.
      if (isWebApp) await updateSetup((current) => skipRemaining({ ...current, mode: "ai" }));
      void navigate({ to: "/", replace: true });
    })();
  };

  const continueLabelProps = isWebApp ? { continueLabel: "Continue" } : {};

  return (
    <OnboardingShell
      stepId={state.stepId}
      stepIndex={state.stepIndex}
      totalSteps={state.totalSteps}
      progressPercent={state.progressPercent}
      isFirst={state.isFirst}
      isLast={state.isLast}
      canContinue={!firstChat.pending && !leaving}
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
      {state.stepId === "web-welcome" && (
        <WorkWelcomeStep
          mode={welcomeMode}
          onModeChange={setWelcomeMode}
          onConfirm={(mode) => void leaveWelcome(mode)}
          onOwnTools={setOwnTools}
        />
      )}
      <OwnToolsDialog
        open={ownTools !== null}
        tab={ownTools ?? "agent"}
        onTabChange={setOwnTools}
        onOpenChange={(open) => {
          if (!open) setOwnTools(null);
        }}
      />
    </OnboardingShell>
  );
}
