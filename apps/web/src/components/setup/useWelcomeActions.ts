/**
 * Leaving the welcome screen: the person picked "just a computer" (the
 * tour) or "a computer with AI" (the guided setup), or skipped it all.
 * Completion is saved first — on this interface (`onboardingCompleted`) and
 * on the machine (`machineOnboarded`) — so the root guard lets the next
 * screen through and the same computer opened elsewhere goes straight in.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { useUpdateSettings } from "../../hooks/useSettings";
import { skipRemaining } from "./setupModel";
import { useStartSetupTour } from "./SetupTour";
import { useSetupNavigation } from "./useSetupNavigation";
import { useUpdateSetupProgress } from "./useSetupProgress";

export type WelcomeMode = "simple" | "ai";

export function useWelcomeActions() {
  const { updateSettings } = useUpdateSettings();
  const updateSetup = useUpdateSetupProgress();
  const navigate = useNavigate();
  const startTour = useStartSetupTour();
  const { goHome } = useSetupNavigation();
  const [leaving, setLeaving] = useState(false);

  const markOnboarded = useCallback(
    () => updateSettings({ onboardingCompleted: true, machineOnboarded: true }),
    [updateSettings],
  );

  const choose = useCallback(
    async (mode: WelcomeMode) => {
      if (leaving) return;
      setLeaving(true);
      try {
        await markOnboarded();
        await updateSetup((current) => ({ ...current, mode }));
        if (mode === "simple") startTour("home");
        else void navigate({ to: "/setup", search: { step: "ai" } });
      } finally {
        setLeaving(false);
      }
    },
    [leaving, markOnboarded, navigate, startTour, updateSetup],
  );

  /** "Skip setup": straight to Home; the setup waits as "Finish setup" in the sidebar. */
  const skip = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await markOnboarded();
      await updateSetup((current) => skipRemaining({ ...current, mode: "ai" }));
      goHome();
    } finally {
      setLeaving(false);
    }
  }, [goHome, leaving, markOnboarded, updateSetup]);

  return { choose, skip, leaving, markOnboarded };
}
