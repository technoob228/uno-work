/**
 * In the sidebar: invitations to someone else's project, waiting for this
 * person's answer. Nothing shows when there are none, or teams aren't on.
 *
 * @module projectSync/ProjectInvites
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toastManager } from "../ui/toast";
import { projectTeamsQueryKey } from "./ProjectTeam";
import { acceptInvite, declineInvite, loadTeams } from "./projectTeam.api";
import { personLabel, teamErrorMessage, type TeamIncomingInvite } from "./projectTeam.logic";

export function ProjectInvites() {
  const queryClient = useQueryClient();
  const teams = useQuery({
    queryKey: projectTeamsQueryKey,
    queryFn: loadTeams,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 120_000,
  });
  const [busy, setBusy] = useState<number | null>(null);
  const invites = teams.data?.invites ?? [];
  if (invites.length === 0) return null;

  const answer = async (item: TeamIncomingInvite, yes: boolean) => {
    setBusy(item.id);
    try {
      await (yes ? acceptInvite(item.id) : declineInvite(item.id));
      if (yes) {
        toastManager.add({ type: "success", title: `You're in ${item.project_name}` });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't answer that invitation",
        description: teamErrorMessage(error),
      });
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: projectTeamsQueryKey });
    }
  };

  return (
    <>
      {invites.map((item) => (
        <li key={item.id} className="list-none px-2.5 py-1.5" data-testid="sidebar-project-invite">
          <p className="text-xs text-sidebar-foreground/80">
            {personLabel(item.owner)} invited you to {item.project_name}
          </p>
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void answer(item, true)}
              className="inline-flex h-6 cursor-pointer items-center rounded-md px-1.5 text-xs text-foreground/80 hover:bg-accent disabled:cursor-wait disabled:opacity-60"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void answer(item, false)}
              className="inline-flex h-6 cursor-pointer items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent disabled:cursor-wait disabled:opacity-60"
            >
              Decline
            </button>
          </div>
        </li>
      ))}
    </>
  );
}
