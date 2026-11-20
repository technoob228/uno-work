/**
 * T51 (d): a message a colleague's agent (or a colleague, in a chat shared
 * with them) put into my chat. The daemon frames it as text from outside
 * with the daemon's first line (`[Uno Work · team] Andrei's agent (…) asks …`, team.logic.ts)
 * (team.logic.ts `parseTeamOutsideText`). Here: who wrote it — their face
 * with the bot badge, their chat, the level it came in under — then their
 * words, never shown as mine.
 */
import { memo } from "react";

import { AGENT_LEVELS, possessive, type TeamOutsideText } from "../../team/team.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TeamAvatar, personOf } from "./TeamAvatar";

export const TeamAgentMessage = memo(function TeamAgentMessage(props: {
  readonly parsed: TeamOutsideText;
}) {
  const { parsed } = props;
  const level = AGENT_LEVELS.find((item) => item.id === parsed.level) ?? null;
  const agent = parsed.kind === "agent";
  const who = agent ? `${possessive(parsed.name)} agent` : parsed.name;
  // No id in the line: the face's tone goes by the name.
  const toneId = [...parsed.name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return (
    <div className="flex flex-col items-start pb-4" data-testid="team-agent-message">
      <div
        className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
        data-testid="team-agent-message-label"
      >
        <TeamAvatar person={personOf(toneId, parsed.name)} agent={agent} className="size-4" />
        <span className="text-foreground">{who}</span>
        {parsed.chatTitle ? <span>· from the chat “{parsed.chatTitle}”</span> : null}
        {!parsed.chatTitle && parsed.project ? <span>· {parsed.project}</span> : null}
        {level ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-default items-center rounded-full border border-border bg-muted/50 px-1.5 py-px text-muted-foreground" />
              }
            >
              {level.label}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-72">
              Your setting for {who}
              {parsed.project ? ` in ${parsed.project}` : ""}. {level.line}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="max-w-[80%] min-w-0 rounded-2xl border border-dashed border-border bg-muted/30 px-3.5 py-2 text-sm break-words whitespace-pre-wrap text-foreground">
        {parsed.body}
      </div>
    </div>
  );
});
