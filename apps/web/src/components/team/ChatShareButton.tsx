/**
 * T51 mockup: "Share" in a chat's header. Picks people of the chat's project
 * and what each gets: nothing, read the chat as it goes, or write in it too.
 * The chat keeps running on this computer; they never get the folder, keys
 * or a terminal. Demo data only (team/teamCollab.ts).
 */
import { LockIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  firstName,
  setChatShare,
  useTeamCollab,
  type ChatShare,
  type ShareLevel,
} from "../../team/teamCollab";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { TeamAvatar } from "./TeamAvatar";

const NONE: ReadonlyArray<ChatShare> = [];

const CHOICES: ReadonlyArray<{ id: ShareLevel | null; label: string }> = [
  { id: null, label: "No access" },
  { id: "read", label: "Can read" },
  { id: "write", label: "Can write" },
];

export const ChatShareButton = memo(function ChatShareButton(props: {
  readonly threadId: string;
  readonly projectName: string | undefined;
  readonly computerName: string;
}) {
  const enabled = useTeamCollab((state) => state.enabled && state.viewer === "misha");
  const project = useTeamCollab((state) => state.project);
  const people = useTeamCollab((state) => state.people);
  const shares = useTeamCollab((state) => state.shares[props.threadId] ?? NONE);
  if (!enabled || props.projectName !== project) return null;
  const others = people.filter((person) => !person.you);
  const shared = shares.map((share) => others.find((person) => person.id === share.personId));
  const anyWrite = shares.some((share) => share.level === "write");

  return (
    <Popover>
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
            {shared.map((person) =>
              person ? (
                <TeamAvatar
                  key={person.id}
                  person={person}
                  className="size-4 ring-1 ring-background"
                />
              ) : null,
            )}
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
              People in <span className="font-medium text-foreground">{project}</span> see it in
              their Uno Work as it goes. It keeps running here, on {props.computerName}.
            </p>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {others.map((person) => {
              const level = shares.find((share) => share.personId === person.id)?.level ?? null;
              return (
                <li
                  key={person.id}
                  className="flex items-center gap-2.5 px-2.5 py-2"
                  data-testid={`chat-share-person-${person.id}`}
                >
                  <TeamAvatar person={person} className="size-7" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{person.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{person.email}</div>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`What ${firstName(person)} gets`}
                    className="flex shrink-0 rounded-md border border-border p-0.5"
                  >
                    {CHOICES.map((choice) => (
                      <button
                        key={choice.label}
                        type="button"
                        role="radio"
                        aria-checked={level === choice.id}
                        onClick={() => setChatShare(props.threadId, person.id, choice.id)}
                        className={cn(
                          "cursor-pointer rounded-[5px] px-1.5 py-0.5 text-[11px] whitespace-nowrap",
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
          <div className="flex items-center justify-between border-t border-border pt-2.5">
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <UserPlusIcon className="size-3.5" />
              Add someone to {project}
            </button>
            <span className="text-[11px] text-muted-foreground">Stop sharing any time</span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
