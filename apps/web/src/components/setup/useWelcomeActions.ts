/**
 * Leaving the welcome screen: the person picked "just a computer" (the
 * tour) or "a computer with AI" (the guided setup), or skipped it all.
 * Completion is recorded on this interface (`onboardingCompleted`, local and
 * immediate — the root guard reads it) and on the machine (`machineOnboarded`
 * + setup progress, so the same computer opened elsewhere goes straight in).
 *
 * The next screen opens at once: the machine's copy is written in the
 * background. Waiting for that round trip (two writes, on a computer still
 * busy starting up) kept the welcome on screen for 3+ s after Skip setup.
 */
import type { UnoSetupProgress } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import { useUpdateSettings } from "../../hooks/useSettings";
import { getServerConfig } from "../../rpc/serverState";
import { toastManager } from "../ui/toast";
import { EMPTY_SETUP_PROGRESS, skipRemaining } from "./setupModel";
import { useStartSetupTour } from "./SetupTour";
import { useSetupNavigation } from "./useSetupNavigation";
import { useUpdateSetupProgress } from "./useSetupProgress";

export type WelcomeMode = "simple" | "ai";

function reportSaveFailure(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Couldn't save your choice on this computer",
    description: error instanceof Error ? error.message : String(error),
  });
}

export function useWelcomeActions() {
  const { updateSettings } = useUpdateSettings();
  const updateSetup = useUpdateSetupProgress();
  const navigate = useNavigate();
  const startTour = useStartSetupTour();
  const { goHome } = useSetupNavigation();
  const [leaving, setLeaving] = useState(false);
  // A second click in the same frame, before `leaving` re-renders.
  const leavingRef = useRef(false);

  const markOnboarded = useCallback(
    () => updateSettings({ onboardingCompleted: true, machineOnboarded: true }),
    [updateSettings],
  );

  /**
   * Records the choice (local flag now, the machine's copy in one write in
   * the background) and returns without waiting for the machine.
   */
  const record = useCallback(
    (change: (current: UnoSetupProgress) => UnoSetupProgress) => {
      const config = getServerConfig();
      const saved =
        config !== null
          ? updateSettings({
              onboardingCompleted: true,
              machineOnboarded: true,
              setup: change(config.settings.setup ?? EMPTY_SETUP_PROGRESS),
            })
          : // Settings not in yet (a very fast click): the local flag goes now,
            // the machine's copy once its settings arrive.
            markOnboarded().then(() => updateSetup(change));
      void saved.catch(reportSaveFailure);
    },
    [markOnboarded, updateSettings, updateSetup],
  );

  const leave = useCallback(
    (change: (current: UnoSetupProgress) => UnoSetupProgress, go: () => void) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      setLeaving(true);
      try {
        record(change);
        go();
      } finally {
        leavingRef.current = false;
        setLeaving(false);
      }
    },
    [record],
  );

  const choose = useCallback(
    (mode: WelcomeMode) => {
      leave(
        (current) => ({ ...current, mode }),
        () => {
          if (mode === "simple") startTour("home");
          else void navigate({ to: "/setup", search: { step: "ai" } });
        },
      );
    },
    [leave, navigate, startTour],
  );

  /** "Skip setup": straight to Home; the setup waits as "Finish setup" in the sidebar. */
  const skip = useCallback(() => {
    leave((current) => skipRemaining({ ...current, mode: "ai" }), goHome);
  }, [goHome, leave]);

  return { choose, skip, leaving, markOnboarded };
}
