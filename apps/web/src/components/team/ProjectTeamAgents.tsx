/**
 * T51 mockup: Project settings → Team, under People. How far other people's
 * agents may go with yours in this project (off → ask me first → answer
 * questions → do tasks), per person when it differs; the chats you share;
 * what their agents did lately. Each person sets this for their own
 * computers. Demo data only (team/teamCollab.ts).
 */
import { BotIcon, HistoryIcon, MessagesSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  AGENT_LEVELS,
  agentLevelLabel,
  firstName,
  personById,
  setAgentLevel,
  setChatShare,
  useTeamCollab,
  type AgentLevel,
} from "../../team/teamCollab";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { TeamAvatar } from "./TeamAvatar";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export function useTeamCollabOn(projectName: string): boolean {
  return useTeamCollab((state) => state.enabled && state.project === projectName);
}

export const ProjectTeamAgents = memo(function ProjectTeamAgents(props: {
  readonly projectName: string;
  readonly environmentId: EnvironmentId;
}) {
  const state = useTeamCollab();
  if (!state.enabled || state.project !== props.projectName) return null;
  const others = state.people.filter((person) => !person.you);
  const sharedChats = Object.entries(state.shares).flatMap(([threadId, shares]) =>
    shares.map((share) => ({ threadId, ...share })),
  );

  return (
    <>
      <section className="space-y-2" data-testid="project-team-agents">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BotIcon className="size-4 text-muted-foreground" />
          Their agents and yours
        </div>
        <p className="text-xs text-muted-foreground">
          What other people's agents in {props.projectName} may do with your agents and your
          computers. Only you set this for yours.
        </p>
        <div className="divide-y divide-border rounded-md border border-border" role="radiogroup">
          {AGENT_LEVELS.map((level) => {
            const on = state.defaultLevel === level.id;
            return (
              <button
                key={level.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setAgentLevel(null, level.id)}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left",
                  on ? "bg-primary/5" : "hover:bg-accent/50",
                )}
                data-testid={`agent-level-${level.id}`}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
                    on ? "border-primary bg-primary" : "border-input bg-background",
                  )}
                >
                  {on ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                    {level.label}
                    {level.id === "ask" ? (
                      <span className="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">
                        default
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {level.line}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <ul className="space-y-1 text-xs">
          {others.map((person) => {
            const own = state.levelFor[person.id];
            return (
              <li key={person.id} className="flex items-center gap-2">
                <TeamAvatar person={person} agent className="size-5" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {firstName(person)}'s agent
                </span>
                <LevelMenu
                  value={own ?? state.defaultLevel}
                  custom={own !== undefined}
                  onPick={(level) => setAgentLevel(person.id, level)}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2" data-testid="project-team-shared-chats">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <MessagesSquareIcon className="size-4 text-muted-foreground" />
          Chats you share
        </div>
        {sharedChats.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None yet. Share a chat from its header: Share.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border text-xs">
            {sharedChats.map((share) => (
              <SharedChatRow
                key={`${share.threadId}:${share.personId}`}
                environmentId={props.environmentId}
                threadId={share.threadId}
                personName={firstName(personById(state, share.personId))}
                level={share.level}
                onStop={() => setChatShare(share.threadId, share.personId, null)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" data-testid="project-team-journal">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <HistoryIcon className="size-4 text-muted-foreground" />
          What their agents did
        </div>
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {state.journal.map((line) => (
            <li key={`${line.at}:${line.text}`} className="flex items-start gap-2 px-3 py-1.5">
              <span className="w-16 shrink-0 text-muted-foreground">{line.at}</span>
              <span className="min-w-0 flex-1 text-foreground">{line.text}</span>
              {line.level ? (
                <span className="shrink-0 rounded-full border border-info/40 px-1.5 text-[10px] text-info">
                  {agentLevelLabel(line.level)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
});

function LevelMenu(props: {
  readonly value: AgentLevel;
  readonly custom: boolean;
  readonly onPick: (level: AgentLevel) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className={cn(!props.custom && "text-muted-foreground")}
          />
        }
      >
        {agentLevelLabel(props.value)}
        {props.custom ? "" : " (default)"}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={props.value}
          onValueChange={(value) => props.onPick(value as AgentLevel)}
        >
          {AGENT_LEVELS.map((level) => (
            <MenuRadioItem key={level.id} value={level.id}>
              {level.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function SharedChatRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly personName: string;
  readonly level: "read" | "write";
  readonly onStop: () => void;
}) {
  const title = useThreadTitle(props.environmentId, props.threadId as ThreadId);
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-foreground">{title ?? props.threadId}</span>
      <span className="shrink-0 text-muted-foreground">
        {props.personName} · {props.level === "read" ? "Can read" : "Can write"}
      </span>
      <Button size="xs" variant="ghost" onClick={props.onStop}>
        Stop
      </Button>
    </li>
  );
}
