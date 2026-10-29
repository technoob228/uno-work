/**
 * Automations through react-query: the list of one computer (the assistant's
 * page) or of every connected computer (the Automations screen), and the
 * changes — each one asks the computer again after it.
 */
import type {
  Automation,
  AutomationCreateInput,
  AutomationListResult,
  AutomationUpdateInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  runAutomationNow,
  updateAutomation,
} from "../../lib/automationsApi";
import { useAssistantsAvailability } from "../assistants/useAssistants";
import { useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";
import { automationsShown, runIsActive } from "./automations.logic";

export const AUTOMATIONS_KEY = ["uno-automations"] as const;

const listKey = (environmentId: string) => [...AUTOMATIONS_KEY, "list", environmentId] as const;
export const runsKey = (environmentId: string, id: number) =>
  [...AUTOMATIONS_KEY, "runs", environmentId, id] as const;

/** Every few seconds while a run is going, else now and then. */
function refetchEvery(data: AutomationListResult | undefined): number {
  return data?.automations.some((item) => runIsActive(item.lastRun)) ? 3_000 : 20_000;
}

function listQuery(environmentId: string) {
  return {
    queryKey: listKey(environmentId),
    queryFn: () => listAutomations({ environmentId: environmentId as EnvironmentId }),
    staleTime: 2_000,
    retry: false,
    refetchInterval: (query: { state: { data: AutomationListResult | undefined } }) =>
      refetchEvery(query.state.data),
  };
}

export function useAutomationsOn(environmentId: string | null) {
  return useQuery({ ...listQuery(environmentId ?? ""), enabled: environmentId !== null });
}

export interface ComputerAutomations {
  readonly environmentId: string;
  readonly data: AutomationListResult | undefined;
  readonly loading: boolean;
  readonly error: unknown;
}

export function useAutomationsAcross(
  environmentIds: ReadonlyArray<string>,
): ReadonlyArray<ComputerAutomations> {
  return useQueries({
    queries: environmentIds.map((environmentId) => listQuery(environmentId)),
    combine: (results) =>
      results.map((result, index) => ({
        environmentId: environmentIds[index]!,
        data: result.data,
        loading: result.isLoading,
        error: result.error,
      })),
  });
}

export function useAutomationRuns(environmentId: string, id: number, enabled: boolean) {
  return useQuery({
    queryKey: runsKey(environmentId, id),
    queryFn: () => listAutomationRuns({ environmentId: environmentId as EnvironmentId, id }),
    enabled,
    retry: false,
    staleTime: 2_000,
  });
}

/** The changes; each asks the computer for the list again (and its runs). */
export function useAutomationActions(environmentId: string) {
  const queryClient = useQueryClient();
  const env = environmentId as EnvironmentId;
  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey(environmentId) });
  const patchLocal = (id: number, patch: Partial<Automation>) =>
    queryClient.setQueryData<AutomationListResult>(listKey(environmentId), (data) =>
      data
        ? {
            ...data,
            automations: data.automations.map((item) =>
              item.id === id ? { ...item, ...patch } : item,
            ),
          }
        : data,
    );
  return {
    create: async (automation: AutomationCreateInput) => {
      const created = await createAutomation({ environmentId: env, automation });
      await refresh();
      return created;
    },
    update: async (id: number, patch: AutomationUpdateInput) => {
      // The switch flips at once; the computer's answer settles it.
      if (patch.enabled !== undefined) patchLocal(id, { enabled: patch.enabled });
      try {
        return await updateAutomation({ environmentId: env, id, patch });
      } finally {
        await refresh();
      }
    },
    remove: async (id: number) => {
      await deleteAutomation({ environmentId: env, id });
      await refresh();
    },
    runNow: async (id: number) => {
      const run = await runAutomationNow({ environmentId: env, id });
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: runsKey(environmentId, id) }),
      ]);
      return run;
    },
  };
}

/**
 * The one answer of the web to "are Automations here" (gating, 28.10): the
 * assistants update on the account and some computer of its assistants says
 * the console has AUTOMATIONS on (`automationsShown`). Without the update no
 * computer is asked at all. "loading" until that is known.
 */
export function useAutomationsGate(): "loading" | "on" | "off" {
  const availability = useAssistantsAvailability();
  const teamShown = useTeamShown();
  const team = useAssistantTeam();
  const environmentIds = useMemo(
    () =>
      teamShown
        ? [
            ...new Set(
              team.filter((member) => !member.revoked).map((member) => member.environmentId),
            ),
          ].toSorted()
        : [],
    [team, teamShown],
  );
  const computers = useAutomationsAcross(environmentIds);
  if (automationsShown({ teamShown, computers: computers.map((computer) => computer.data) })) {
    return "on";
  }
  if (!teamShown) return availability === "loading" ? "loading" : "off";
  // The team arrives a moment after the account (Uno's computer included): with
  // nobody to ask yet it is not "off" — /automations opened directly (a reload,
  // a link) went to the start screen on the account that has it (0.0.159 smoke).
  if (environmentIds.length === 0) return "loading";
  return computers.some((computer) => computer.loading) ? "loading" : "off";
}

/** Anything of Automations shows (see `useAutomationsGate`). */
export function useAutomationsShown(): boolean {
  return useAutomationsGate() === "on";
}
