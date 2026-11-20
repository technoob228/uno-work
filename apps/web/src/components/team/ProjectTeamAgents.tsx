/**
 * T51 (c)(d): Project settings → Team, under the people list.
 *
 * - "Their agents and yours": how far other people's agents may go with
 *   yours in this project (Off → Ask me first → Answer questions → Do tasks).
 *   The owner sets it for the project and per person; everyone else sees
 *   that and may only lower it for their own computers (`levels/mine`).
 * - "Chats you share", each with Stop.
 * - "What their agents did": the project's journal.
 *
 * Nothing while T51's parts are off; "Do tasks" only with the tasks part.
 */
import { useQueryClient } from "@tanstack/react-query";
import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon, HistoryIcon, MessagesSquareIcon } from "lucide-react";
import { memo, useState } from "react";

import { journalTimeLabel } from "../../chatRequests/chatRequests.logic";
import { cn } from "../../lib/utils";
import { teamProjectOf } from "../projectSync/projectTeam.logic";
import { setCeilingLevel, setMyLevel, shareChat } from "../../team/teamApi";
import {
  teamCollabErrorMessage,
  type AgentLevel,
  type SharedChat,
  type TeamLevels,
  type TeamParts,
  type TeamPersonRef,
} from "../../team/teamApi.logic";
import {
  DEFAULT_AGENT_LEVEL,
  agentLevelLabel,
  ceilingFor,
  firstName,
  levelsAtMost,
  otherPeople,
  possessive,
  shareLevelLabel,
  visibleLevels,
} from "../../team/team.logic";
import { teamDaemonRefresh } from "../../team/teamRpc";
import {
  personFromCard,
  teamLevelsQueryKey,
  useInvalidateTeamChats,
  useMyUserId,
  useProjectChats,
  useTeamCard,
  useTeamJournal,
  useTeamLevels,
  useTeamParts,
  useTeamsList,
} from "../../team/teamStore";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { TeamAvatar } from "./TeamAvatar";

const UNSET = "unset";

export const ProjectTeamAgents = memo(function ProjectTeamAgents(props: {
  readonly syncName: string;
  readonly teamId: number | null;
}) {
  const parts = useTeamParts();
  const on = parts.share || parts.requests || parts.agents;
  const teams = useTeamsList(on);
  const row = teamProjectOf(teams.data, props.syncName, props.teamId);
  const projectId = row?.id ?? null;
  const card = useTeamCard(projectId);
  const meId = useMyUserId(on);
  if (!on || projectId === null || !card.data || meId === null) return null;
  const people: ReadonlyArray<TeamPersonRef> = otherPeople(
    card.data.members.map((member) => ({
      userId: member.user_id,
      email: member.email,
      username: member.username,
    })),
    meId,
  );
  const ownerMember = card.data.members.find((member) => member.role === "owner") ?? null;
  const ownerName = ownerMember
    ? firstName({
        userId: ownerMember.user_id,
        email: ownerMember.email,
        username: ownerMember.username,
      })
    : "The owner";
  return (
    <>
      {parts.agents ? (
        <AgentLevelsSection
          projectId={projectId}
          projectName={row?.name ?? props.syncName}
          people={people}
          ownerName={ownerName}
          parts={parts}
        />
      ) : null}
      {parts.share ? <SharedChatsSection projectId={projectId} card={card.data} /> : null}
      {parts.agents || parts.requests ? (
        <JournalSection projectId={projectId} card={card.data} />
      ) : null}
    </>
  );
});

function useLevelChange(projectId: number) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const change = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Not saved",
        description: teamCollabErrorMessage(error),
      });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: teamLevelsQueryKey(projectId) });
    }
  };
  return { busy, change };
}

function AgentLevelsSection(props: {
  readonly projectId: number;
  readonly projectName: string;
  readonly people: ReadonlyArray<TeamPersonRef>;
  readonly ownerName: string;
  readonly parts: TeamParts;
}) {
  const levels = useTeamLevels(props.projectId, true);
  const { busy, change } = useLevelChange(props.projectId);
  const data = levels.data;
  return (
    <section className="space-y-2" data-testid="project-team-agents">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <BotIcon className="size-4 text-muted-foreground" />
        Their agents and yours
      </div>
      {!data ? null : data.canSet ? (
        <OwnerLevels {...props} levels={data} busy={busy} change={change} />
      ) : (
        <MemberLevels {...props} levels={data} busy={busy} change={change} />
      )}
    </section>
  );
}

type LevelProps = Parameters<typeof AgentLevelsSection>[0] & {
  readonly levels: TeamLevels;
  readonly busy: boolean;
  readonly change: (run: () => Promise<unknown>) => Promise<void>;
};

function OwnerLevels(props: LevelProps) {
  const { levels, parts } = props;
  const value = levels.ceiling.default ?? DEFAULT_AGENT_LEVEL;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        What people's agents in {props.projectName} may do with each other's agents and computers.
        Each person can lower it for their own computers, not raise it.
      </p>
      <div
        className="divide-y divide-border rounded-md border border-border"
        role="radiogroup"
        aria-label="For everyone in the project"
      >
        {visibleLevels(parts).map((level) => {
          const checked = value === level.id;
          return (
            <button
              key={level.id}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={props.busy}
              onClick={() => void props.change(() => setCeilingLevel(props.projectId, 0, level.id))}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left disabled:cursor-default",
                checked ? "bg-primary/5" : "hover:bg-accent/50",
              )}
              data-testid={`agent-level-${level.id}`}
            >
              <RadioDot on={checked} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  {level.label}
                  {level.id === DEFAULT_AGENT_LEVEL ? (
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
      {props.people.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {props.people.map((person) => {
            const own = levels.ceiling.people[person.userId] ?? null;
            return (
              <li key={person.userId} className="flex items-center gap-2">
                <TeamAvatar person={person} agent className="size-5" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {possessive(firstName(person))} agent
                </span>
                <LevelMenu
                  value={own}
                  unsetLabel={`${agentLevelLabel(value)} (everyone)`}
                  options={visibleLevels(parts)}
                  disabled={props.busy}
                  testId={`agent-level-person-${person.userId}`}
                  onPick={(level) =>
                    void props.change(() => setCeilingLevel(props.projectId, person.userId, level))
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

function MemberLevels(props: LevelProps) {
  const { levels, parts } = props;
  const everyone = levels.ceiling.default ?? DEFAULT_AGENT_LEVEL;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {props.ownerName} set what people's agents in {props.projectName} may do:{" "}
        <span className="text-foreground">{agentLevelLabel(everyone)}</span>. You can lower it for
        your computers. What applies is the lower of the two.
      </p>
      <ul
        className="divide-y divide-border rounded-md border border-border text-xs"
        data-testid="agent-levels-mine"
      >
        <MemberLevelRow
          {...props}
          label="Everyone's agents"
          person={null}
          ceiling={everyone}
          mine={levels.mine.default}
          applies={null}
        />
        {props.people.map((person) => {
          const ceiling = ceilingFor(levels.ceiling, person.userId);
          return (
            <MemberLevelRow
              key={person.userId}
              {...props}
              label={`${possessive(firstName(person))} agent`}
              person={person}
              ceiling={ceiling}
              mine={levels.mine.people[person.userId] ?? null}
              applies={levels.effectiveIn[person.userId] ?? null}
            />
          );
        })}
      </ul>
      {parts.tasks ? null : (
        <p className="text-[11px] text-muted-foreground">
          Do tasks isn't available yet; it counts as Answer questions.
        </p>
      )}
    </>
  );
}

function MemberLevelRow(
  props: LevelProps & {
    readonly label: string;
    readonly person: TeamPersonRef | null;
    readonly ceiling: AgentLevel;
    readonly mine: AgentLevel | null;
    readonly applies: AgentLevel | null;
  },
) {
  const senderId = props.person?.userId ?? 0;
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      {props.person ? (
        <TeamAvatar person={props.person} agent className="size-5" />
      ) : (
        <BotIcon className="size-4 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground">{props.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {props.ownerName}: {agentLevelLabel(props.ceiling)}
          {props.applies ? ` · applies: ${agentLevelLabel(props.applies)}` : ""}
        </span>
      </span>
      <LevelMenu
        value={props.mine}
        unsetLabel="Not lowered"
        prefix="For my computers: "
        options={levelsAtMost(props.ceiling, props.parts)}
        disabled={props.busy}
        testId={`agent-level-mine-${senderId}`}
        onPick={(level) => void props.change(() => setMyLevel(props.projectId, senderId, level))}
      />
    </li>
  );
}

function RadioDot(props: { readonly on: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
        props.on ? "border-primary bg-primary" : "border-input bg-background",
      )}
    >
      {props.on ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
    </span>
  );
}

function LevelMenu(props: {
  readonly value: AgentLevel | null;
  readonly unsetLabel: string;
  readonly prefix?: string;
  readonly options: ReadonlyArray<{ readonly id: AgentLevel; readonly label: string }>;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onPick: (level: AgentLevel | null) => void;
}) {
  const label = props.value ? agentLevelLabel(props.value) : props.unsetLabel;
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <Button
            size="xs"
            variant="outline"
            className={cn("shrink-0", props.value === null && "text-muted-foreground")}
            data-testid={props.testId}
          />
        }
      >
        {props.prefix}
        {label}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={props.value ?? UNSET}
          onValueChange={(value) => props.onPick(value === UNSET ? null : (value as AgentLevel))}
        >
          <MenuRadioItem value={UNSET}>{props.unsetLabel}</MenuRadioItem>
          {props.options.map((level) => (
            <MenuRadioItem key={level.id} value={level.id}>
              {level.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

type Card = NonNullable<ReturnType<typeof useTeamCard>["data"]>;

function SharedChatsSection(props: { readonly projectId: number; readonly card: Card }) {
  const chats = useProjectChats(props.projectId, true);
  const invalidate = useInvalidateTeamChats();
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (chats.data?.mine ?? []).flatMap((chat) =>
    chat.shares.map((share) => ({ chat, share })),
  );

  const stop = async (chat: SharedChat, userId: number) => {
    setBusy(`${chat.id}:${userId}`);
    try {
      await shareChat({
        projectId: props.projectId,
        source: chat.source,
        threadId: chat.threadId,
        title: chat.title,
        computer: chat.computer,
        userId,
        level: "none",
      });
      invalidate(props.projectId);
      void teamDaemonRefresh(chat.source as EnvironmentId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't stop sharing",
        description: teamCollabErrorMessage(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2" data-testid="project-team-shared-chats">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <MessagesSquareIcon className="size-4 text-muted-foreground" />
        Chats you share
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. Share a chat from its header: Share.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {rows.map(({ chat, share }) => {
            const person = personFromCard(props.card, {
              userId: share.userId,
              email: null,
              username: "",
            });
            const key = `${chat.id}:${share.userId}`;
            return (
              <li key={key} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {chat.title || "A chat"}
                  <span className="text-muted-foreground"> · {chat.computer}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {firstName(person)} · {shareLevelLabel(share.level)}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void stop(chat, share.userId)}
                  data-testid={`shared-chat-stop-${key}`}
                >
                  Stop
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function JournalSection(props: { readonly projectId: number; readonly card: Card }) {
  const journal = useTeamJournal(props.projectId, true);
  const entries = journal.data ?? [];
  return (
    <section className="space-y-2" data-testid="project-team-journal">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <HistoryIcon className="size-4 text-muted-foreground" />
        What their agents did
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {journal.isPending ? "Loading…" : "Nothing yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 px-3 py-1.5">
              <span className="w-24 shrink-0 text-muted-foreground">
                {journalTimeLabel(entry.at)}
              </span>
              <TeamAvatar
                person={personFromCard(props.card, entry.actor)}
                agent={entry.viaAgent}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1 text-foreground">{entry.text}</span>
              {entry.level ? (
                <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                  {agentLevelLabel(entry.level)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
