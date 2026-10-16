/**
 * Under the Inbox card "Uno set up assistant Scout" (decision 14.10: an
 * assistant sets up another within its own access without asking — the
 * person gets this notice): look at it, or revoke it right here.
 */
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { assistantKeyOf } from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";

export function AssistantNoticeActions(props: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly onOpen: () => void;
}) {
  const navigate = useNavigate();
  const key = assistantKeyOf(props.environmentId, props.projectId);
  const profile = useAssistantTeamStore((state) => state.profiles[key]);
  const revoke = useAssistantTeamStore((state) => state.revoke);
  const restore = useAssistantTeamStore((state) => state.restore);
  if (!profile) return null;
  const revoked = profile.revokedAt !== null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="inbox-assistant-actions">
      <Button size="xs" variant="outline" onClick={props.onOpen}>
        Open {profile.name}
      </Button>
      {revoked ? (
        <>
          <span className="px-1 text-xs text-muted-foreground">Revoked</span>
          <Button size="xs" variant="ghost" onClick={() => restore(key)}>
            Bring back
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => {
            revoke(key);
            toastManager.add({
              type: "success",
              title: `${profile.name} is revoked`,
              description: "Its chats stay. Bring it back from its page.",
              actionProps: {
                children: "Open",
                onClick: () =>
                  void navigate({
                    to: "/assistants",
                    search: { view: "profile", env: props.environmentId, project: props.projectId },
                  }),
              },
            });
          }}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}
