/**
 * Under the Inbox card "Uno set up assistant Scout" (decision 14.10: an
 * assistant sets up another within its own access without asking — the
 * person gets this notice): look at it, or revoke it right here.
 */
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useTeamMember } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";

export function AssistantNoticeActions(props: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly onOpen: () => void;
  /** Next to the row's own Open / Done / Snooze. */
  readonly revokeOnly?: boolean;
}) {
  const navigate = useNavigate();
  const member = useTeamMember(props.environmentId, props.projectId);
  const actions = useTeamActions();
  const [busy, setBusy] = useState(false);
  if (!member) return null;
  const { profile } = member;
  const target = { environmentId: props.environmentId, projectId: props.projectId };
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change it",
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="contents" data-testid="inbox-assistant-actions">
      {props.revokeOnly ? null : (
        <Button size="xs" variant="outline" onClick={props.onOpen}>
          Open {profile.name}
        </Button>
      )}
      {member.revoked ? (
        <>
          <span className="px-1 text-xs text-muted-foreground">Revoked</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => actions.restore(target))}
          >
            Bring back
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const more = await actions.revoke(target);
              toastManager.add({
                type: "success",
                title: `${profile.name} is revoked`,
                description:
                  more > 0
                    ? `And ${more} assistant${more === 1 ? "" : "s"} it set up. Their chats stay.`
                    : "Its chats stay. Bring it back from its page.",
                actionProps: {
                  children: "Open",
                  onClick: () =>
                    void navigate({
                      to: "/assistants",
                      search: {
                        view: "profile",
                        env: props.environmentId,
                        project: props.projectId,
                      },
                    }),
                },
              });
            })
          }
        >
          Revoke
        </Button>
      )}
    </div>
  );
}
