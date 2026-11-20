/**
 * T51 mockup: a message another person's agent wrote in your chat. Above it,
 * who wrote it (the person's face with the bot badge, their chat) and the
 * level of yours it came in under; above the composer, the T49 line — text
 * from another person's agent is text from outside. Demo data only.
 */
import { memo, useState } from "react";

import {
  AGENT_LEVELS,
  firstName,
  personById,
  useTeamCollab,
  type TeamAgentSender,
} from "../../team/teamCollab";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TeamAvatar } from "./TeamAvatar";

export function useTeamAgentSender(sentByThreadId: string): TeamAgentSender | null {
  return useTeamCollab((state) =>
    state.enabled ? (state.agentSenders[sentByThreadId] ?? null) : null,
  );
}

export const TeamAgentMessageLabel = memo(function TeamAgentMessageLabel(props: {
  readonly sender: TeamAgentSender;
}) {
  const person = useTeamCollab((state) => personById(state, props.sender.personId));
  const level = AGENT_LEVELS.find((item) => item.id === props.sender.level);
  const name = firstName(person);
  return (
    <div
      className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="team-agent-message-label"
    >
      <TeamAvatar person={person} agent className="size-4" />
      <span className="text-foreground">{name}'s agent</span>
      <span>· from his chat “{props.sender.chatTitle}”</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center gap-1 rounded-full border border-info/40 bg-info/8 px-1.5 py-px text-info" />
          }
        >
          {level?.label}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="max-w-72">
          Your setting for {name}'s agent in this project. {level?.line}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

/** The T49 line above the composer, naming whose agent. */
export const TeamAgentNote = memo(function TeamAgentNote(props: { readonly threadId: string }) {
  const personId = useTeamCollab((state) =>
    state.enabled ? (state.markedChats[props.threadId] ?? null) : null,
  );
  const person = useTeamCollab((state) => (personId ? personById(state, personId) : null));
  const [trusted, setTrusted] = useState(false);
  if (!personId || trusted) return null;
  return (
    <p
      className="mx-auto mb-1.5 flex max-w-3xl flex-wrap items-center gap-x-1.5 px-3 text-xs text-muted-foreground"
      role="status"
      data-testid="team-agent-note"
    >
      <span>
        This chat has text from {firstName(person)}'s agent. Uno Work tools ask you first.
      </span>
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => setTrusted(true)}
      >
        Trust this chat
      </button>
    </p>
  );
});
