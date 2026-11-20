/**
 * T51 (a): "Share" in a chat's header, only in a chat whose project has a
 * team. Picks people of that project and what each gets: nothing, read the
 * chat as it goes, or write in it too. The chat keeps running on this
 * computer; they never get its folder, keys or a terminal. After a change,
 * this computer's Work is told to mirror now (`team.refresh`); the label
 * becomes "Shared" with their faces.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { LockIcon, UsersIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";
import { shareChat } from "../../team/teamApi";
import { teamCollabErrorMessage, type TeamPersonRef } from "../../team/teamApi.logic";
import {
  SHARE_CHOICES,
  firstName,
  myChatFor,
  otherPeople,
  personName,
  shareOf,
  type ShareChoice,
} from "../../team/team.logic";
import { mirrorErrorFor, teamDaemonRefresh, teamDaemonState } from "../../team/teamRpc";
import {
  useChatTeamProject,
  useInvalidateTeamChats,
  useMyUserId,
  useProjectChats,
  useTeamCard,
  useTeamParts,
} from "../../team/teamStore";
import { useSidebarEnvironmentLabelResolver } from "../sidebar/useSidebarMachineIdentities";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { TeamAvatar } from "./TeamAvatar";

export const ChatShareButton = memo(function ChatShareButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectId: string | undefined;
  readonly title: string;
  readonly computerName: string | null;
}) {
  const parts = useTeamParts();
  const team = useChatTeamProject(props.environmentId, props.projectId, parts.share);
  const card = useTeamCard(team?.projectId ?? null);
  const meId = useMyUserId(parts.share);
  const chats = useProjectChats(team?.projectId ?? null, parts.share);
  const invalidate = useInvalidateTeamChats();
  const labelOf = useSidebarEnvironmentLabelResolver();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const daemon = useQuery({
    queryKey: ["teamDaemonState", props.environmentId],
    queryFn: () => teamDaemonState(props.environmentId),
    enabled: open,
    staleTime: 5_000,
  });
  if (!parts.share || !team || !card.data || meId === null) return null;

  const others: ReadonlyArray<TeamPersonRef> = otherPeople(
    card.data.members.map((member) => ({
      userId: member.user_id,
      email: member.email,
      username: member.username,
    })),
    meId,
  );
  if (others.length === 0) return null;
  const chat = myChatFor(chats.data?.mine ?? [], props.environmentId, props.threadId);
  const shared = others.filter((person) => shareOf(chat, person.userId) !== null);
  const anyWrite = chat?.shares.some((share) => share.level === "write") ?? false;
  const computer = props.computerName ?? labelOf(props.environmentId) ?? "this computer";
  const mirrorError = mirrorErrorFor(daemon.data, props.threadId);

  const pick = async (person: TeamPersonRef, level: ShareChoice) => {
    setBusy(person.userId);
    try {
      await shareChat({
        projectId: team.projectId,
        source: props.environmentId,
        threadId: props.threadId,
        title: props.title,
        computer,
        userId: person.userId,
        level,
      });
      invalidate(team.projectId);
      void teamDaemonRefresh(props.environmentId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't change sharing",
        description: teamCollabErrorMessage(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 gap-1.5"
            data-testid="chat-share-button"
          />
        }
      >
        {shared.length > 0 ? (
          <span className="flex -space-x-1">
            {shared.map((person) => (
              <TeamAvatar
                key={person.userId}
                person={person}
                className="size-4 ring-1 ring-background"
              />
            ))}
          </span>
        ) : (
          <UsersIcon className="size-3" />
        )}
        {shared.length > 0 ? "Shared" : "Share"}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[26rem]" data-testid="chat-share-popover">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-foreground">Share this chat</div>
            <p className="text-xs text-muted-foreground">
              People in <span className="font-medium text-foreground">{team.name}</span> see it in
              their Uno Work as it goes. It keeps running here, on {computer}.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {others.map((person) => {
              const level = shareOf(chat, person.userId) ?? "none";
              return (
                <li
                  key={person.userId}
                  className="flex items-center gap-2.5 px-2.5 py-2"
                  data-testid={`chat-share-person-${person.userId}`}
                >
                  <TeamAvatar person={person} className="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{personName(person)}</div>
                    {person.email && person.email !== personName(person) ? (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {person.email}
                      </div>
                    ) : null}
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`What ${firstName(person)} gets`}
                    className="flex shrink-0 rounded-md border border-border p-0.5"
                  >
                    {SHARE_CHOICES.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        role="radio"
                        aria-checked={level === choice.id}
                        disabled={busy !== null}
                        onClick={() => {
                          if (level !== choice.id) void pick(person, choice.id);
                        }}
                        className={cn(
                          "cursor-pointer rounded-[5px] px-1.5 py-0.5 text-[11px] whitespace-nowrap disabled:cursor-default",
                          level === choice.id
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <li className="flex gap-2">
              <LockIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                They see the conversation, not your computer: no files, keys, .env or terminal.
              </span>
            </li>
            <li className={cn("flex gap-2", anyWrite && "text-foreground")}>
              <UsersIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Can write: their messages go to your agent here, marked as theirs. Uno Work tools
                ask you first, as with any text from outside.
              </span>
            </li>
          </ul>
          {mirrorError ? (
            <p className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
              Not updating for them right now: {mirrorError}
            </p>
          ) : null}
          <div className="flex items-center justify-between border-t border-border pt-2.5 text-[11px] text-muted-foreground">
            <span>People come from {team.name}'s Team in Project settings</span>
            <span>Stop sharing any time</span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
