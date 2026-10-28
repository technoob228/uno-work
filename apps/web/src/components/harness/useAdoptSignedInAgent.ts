/**
 * After a harness sign-in lands in one of Work's dialogs: new chats start on
 * that agent, and the assistant moves to the person's Claude plan (see
 * agentSignInAdoption.ts for the rules). Called by useHarnessSetup — every
 * sign-in dialog goes through it.
 *
 * @module components/harness/useAdoptSignedInAgent
 */
import {
  AI_PROVIDER_LABELS,
  type EnvironmentId,
  type ProviderAuthDriver,
  type ProviderAuthMethod,
} from "@t3tools/contracts";
import { SUBSCRIPTION_DEFAULT_MODEL } from "@t3tools/shared/assistantLlm";
import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef } from "react";

import { assistantLlmQueryKey } from "../../assistant/useAssistantLlm";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSupportsAssistantLlm } from "../../environments/assistantChatSupport";
import { useEnvironmentProviders } from "../../environments/settings/serverSettings";
import { useSettings } from "../../hooks/useSettings";
import { getAssistantLlmStatus, setAssistantLlm } from "../../lib/assistantLlmApi";
import { toastManager } from "../ui/toast";
import {
  CLAUDE_PLAN_POLL_MS,
  CLAUDE_PLAN_WAIT_MS,
  assistantAdoption,
  signedInChatSelection,
} from "./agentSignInAdoption";

export interface AdoptSignedInAgentOptions {
  /** New chats start on the agent that signed in. Default true. */
  readonly newChats?: boolean;
  /**
   * The assistant moves to the Claude plan. Default true; false where the
   * dialog switches the assistant itself (the "What powers Uno" cards).
   */
  readonly assistant?: boolean;
}

/** One move at a time per computer (two dialogs could see the same sign-in). */
const movingAssistant = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useAdoptSignedInAgent(
  environmentId: EnvironmentId | null,
  options: AdoptSignedInAgentOptions = {},
): (driver: ProviderAuthDriver, method: ProviderAuthMethod) => void {
  const providers = useEnvironmentProviders(environmentId);
  const settings = useSettings();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);
  const assistantSupported = useEnvironmentSupportsAssistantLlm(environmentId);
  // Optional: a sign-in surface rendered outside the app's query client
  // (a test, an embed) still signs in; Settings just catches up on its poll.
  const queryClient = useContext(QueryClientContext) ?? null;
  const newChats = options.newChats !== false;
  const assistant = options.assistant !== false;

  // The latest of everything, read when the sign-in lands (the callback is
  // handed to a poller that outlives renders).
  const latest = useRef({ providers, settings, assistantSupported, newChats, assistant });
  useEffect(() => {
    latest.current = { providers, settings, assistantSupported, newChats, assistant };
  });

  const moveAssistant = useCallback(
    async (envId: EnvironmentId, method: ProviderAuthMethod) => {
      if (movingAssistant.has(envId)) return;
      movingAssistant.add(envId);
      try {
        const deadline = Date.now() + CLAUDE_PLAN_WAIT_MS;
        for (;;) {
          const status = await getAssistantLlmStatus({ environmentId: envId }).catch(() => null);
          const next = assistantAdoption({ driver: "claudeAgent", method, status });
          if (next === "skip") return;
          if (next === "switch") break;
          if (Date.now() >= deadline) return;
          await sleep(CLAUDE_PLAN_POLL_MS);
        }
        try {
          const status = await setAssistantLlm({
            environmentId: envId,
            provider: "claude",
            model: SUBSCRIPTION_DEFAULT_MODEL.claude,
          });
          queryClient?.setQueryData(assistantLlmQueryKey(envId), status);
          toastManager.add({
            type: "success",
            title: `Uno runs on your ${AI_PROVIDER_LABELS.claude} plan too`,
            description: "Same sign-in — nothing else to set up. Change it in Settings → AI.",
          });
        } catch (error) {
          void queryClient?.invalidateQueries({ queryKey: assistantLlmQueryKey(envId) });
          toastManager.add({
            type: "warning",
            title: "Uno stays on Uno AI for now",
            description: `Claude Code is signed in. ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      } finally {
        movingAssistant.delete(envId);
      }
    },
    [queryClient],
  );

  return useCallback(
    (driver: ProviderAuthDriver, method: ProviderAuthMethod) => {
      const current = latest.current;
      if (current.newChats) {
        const selection = signedInChatSelection({
          driver,
          providers: current.providers,
          settings: current.settings,
        });
        if (selection) setSticky(selection);
      }
      if (
        current.assistant &&
        current.assistantSupported &&
        environmentId !== null &&
        driver === "claudeAgent" &&
        method === "oauth"
      ) {
        void moveAssistant(environmentId, method);
      }
    },
    [environmentId, moveAssistant, setSticky],
  );
}
