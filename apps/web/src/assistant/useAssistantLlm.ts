/**
 * The Uno assistant's engine on a computer (0.0.84): Hermes' state, the LLM
 * provider and model. Polls while Hermes is being installed or checked, so
 * the progress line moves and the chat unlocks by itself.
 */
import type { AssistantLlmProvider, AssistantLlmStatus, EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useEnvironmentSupportsAssistantLlm } from "../environments/assistantChatSupport";
import {
  ensureAssistantHarness,
  getAssistantLlmStatus,
  setAssistantLlm,
} from "../lib/assistantLlmApi";

export const assistantLlmQueryKey = (environmentId: EnvironmentId | null) =>
  ["uno-assistant", "llm", environmentId] as const;

const BUSY_POLL_MS = 2_000;
const IDLE_POLL_MS = 60_000;

export interface AssistantLlmState {
  readonly supported: boolean;
  readonly status: AssistantLlmStatus | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly switching: boolean;
  readonly retryingHarness: boolean;
  readonly setLlm: (input: {
    readonly provider: AssistantLlmProvider;
    readonly model: string;
  }) => Promise<void>;
  readonly retryHarness: () => Promise<void>;
}

export function useAssistantLlm(environmentId: EnvironmentId | null): AssistantLlmState {
  const supported = useEnvironmentSupportsAssistantLlm(environmentId);
  const queryClient = useQueryClient();
  const queryKey = assistantLlmQueryKey(environmentId);
  const query = useQuery({
    queryKey,
    queryFn: () => getAssistantLlmStatus({ environmentId: environmentId! }),
    enabled: supported && environmentId !== null,
    retry: false,
    refetchInterval: (current) => {
      const state = current.state.data?.harness.state;
      return state === "installing" || state === "checking" ? BUSY_POLL_MS : IDLE_POLL_MS;
    },
  });

  const switchMutation = useMutation({
    mutationFn: (input: { readonly provider: AssistantLlmProvider; readonly model: string }) =>
      setAssistantLlm({ environmentId: environmentId!, ...input }),
    onSuccess: (status) => queryClient.setQueryData(queryKey, status),
  });
  const retryMutation = useMutation({
    mutationFn: () => ensureAssistantHarness({ environmentId: environmentId! }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const setLlm = useCallback<AssistantLlmState["setLlm"]>(
    async (input) => {
      await switchMutation.mutateAsync(input);
    },
    [switchMutation],
  );
  const retryHarness = useCallback(async () => {
    await retryMutation.mutateAsync();
  }, [retryMutation]);

  return {
    supported,
    status: query.data ?? null,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    switching: switchMutation.isPending,
    retryingHarness: retryMutation.isPending,
    setLlm,
    retryHarness,
  };
}
