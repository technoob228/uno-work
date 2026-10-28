/**
 * What the person changes on the team — revoke, bring back, who it is, "set
 * up again" — sent to the computer it lives on (the daemon keeps the team
 * and cuts what an assistant set up when its rights shrink, 22.10). The mock
 * (`?demo=w0138`) changes its own profiles in this browser.
 */
import type { AssistantTeamUpdateInput, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { DEMO_PROTOTYPE } from "../../demo/demoFlag";
import {
  revokeAssistant,
  startAssistantSetupChat,
  updateAssistantTeam,
} from "../../lib/managerApi";
import { assistantKeyOf } from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";

export interface TeamTarget {
  readonly environmentId: string;
  readonly projectId: string;
}

export function useTeamActions() {
  const queryClient = useQueryClient();
  const storeRevoke = useAssistantTeamStore((state) => state.revoke);
  const storeRestore = useAssistantTeamStore((state) => state.restore);
  const storePatch = useAssistantTeamStore((state) => state.patch);

  return useMemo(() => {
    const refresh = () => queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
    return {
      refresh,
      /** Revokes it and everything it set up; how many went with it. */
      revoke: async (target: TeamTarget): Promise<number> => {
        if (DEMO_PROTOTYPE)
          return storeRevoke(assistantKeyOf(target.environmentId, target.projectId));
        const { affected } = await revokeAssistant({
          environmentId: target.environmentId as EnvironmentId,
          projectId: target.projectId,
          revoked: true,
        });
        await refresh();
        return Math.max(0, affected.length - 1);
      },
      restore: async (target: TeamTarget): Promise<void> => {
        if (DEMO_PROTOTYPE) {
          storeRestore(assistantKeyOf(target.environmentId, target.projectId));
          return;
        }
        await revokeAssistant({
          environmentId: target.environmentId as EnvironmentId,
          projectId: target.projectId,
          revoked: false,
        });
        await refresh();
      },
      /** Who it is on the team; "Later" on its setup is `setup: "done"`. */
      update: async (
        target: TeamTarget,
        input: Omit<AssistantTeamUpdateInput, "projectId">,
      ): Promise<void> => {
        if (DEMO_PROTOTYPE) {
          storePatch(assistantKeyOf(target.environmentId, target.projectId), {
            ...(input.name ? { name: input.name } : {}),
            ...(input.setup === "done" ? { setUpAt: new Date().toISOString() } : {}),
            ...(input.paused !== undefined
              ? { pausedAt: input.paused ? new Date().toISOString() : null }
              : {}),
          });
          return;
        }
        await updateAssistantTeam({
          environmentId: target.environmentId as EnvironmentId,
          projectId: target.projectId,
          ...input,
        });
        await refresh();
      },
      /** Its setup chat — the open one, or a new one where it stopped. */
      startSetup: async (target: TeamTarget): Promise<ThreadId> => {
        const { threadId } = await startAssistantSetupChat({
          environmentId: target.environmentId as EnvironmentId,
          projectId: target.projectId,
        });
        void refresh();
        return threadId;
      },
    };
  }, [queryClient, storePatch, storeRestore, storeRevoke]);
}
