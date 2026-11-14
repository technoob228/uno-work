/**
 * Into the developer way from Home's "Move my projects here" chip (Misha
 * 13.11). Signed in already: the sign-in step is done the way its Continue
 * does it (the agent new chats start on, the answer the first chat reads),
 * and it opens at the import.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useSettings } from "../../hooks/useSettings";
import { useServerProviders } from "../../rpc/serverState";
import { devAgentSelection, devWayStart, parseDevAgent } from "./devAgent";
import { DEV_AGENT_KEY } from "./devSetup";
import { withAnswer } from "./goals";
import { markCompleted, withSetupFlow } from "./setupModel";
import { currentSetupProgress, useUpdateSetupProgress } from "./useSetupProgress";

export function useOpenDevWay(): () => Promise<void> {
  const providers = useServerProviders();
  const settings = useSettings();
  const update = useUpdateSetupProgress();
  const navigate = useNavigate();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);
  return useCallback(async () => {
    const saved = parseDevAgent(currentSetupProgress().answers[DEV_AGENT_KEY]);
    const start = devWayStart(providers, saved);
    const selection =
      start.step === "import" ? devAgentSelection(start.agent, providers, settings) : null;
    if (start.step === "import" && selection) {
      setSticky(selection);
      await update((current) =>
        markCompleted(
          withAnswer(withSetupFlow(current, "dev"), DEV_AGENT_KEY, start.agent),
          "sign-in",
        ),
      );
      await navigate({ to: "/setup", search: { step: "import" } });
      return;
    }
    await navigate({ to: "/setup", search: { step: "sign-in" } });
  }, [navigate, providers, settings, setSticky, update]);
}
