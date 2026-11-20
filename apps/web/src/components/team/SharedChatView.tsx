/**
 * T51 (a), the colleague's side: a chat someone in the project shared with
 * me (`/shared/$chatId`). The feed comes from the Uno cloud, live (a long
 * poll on its events): the owner's messages and their agent's answers, a
 * colleague's messages signed, "ran N commands" lines muted — never tool
 * output, files or keys. With "Can read": "Ask to write" and "Continue in my
 * own chat" (a new chat here, the conversation quoted as text from outside).
 * With "Can write": a composer; the message goes to the owner's agent as mine.
 */
import { EyeIcon, PencilIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";

import ChatMarkdown, { RemoteImagesOffContext } from "../ChatMarkdown";
import { cn } from "../../lib/utils";
import type { FeedEvent, TeamPersonRef } from "../../team/teamApi.logic";
import { firstName, personName, possessive, shareLevelLabel } from "../../team/team.logic";
import {
  personFromCard,
  useMyUserId,
  useSharedChatFeed,
  useSharedWithMe,
  useTeamCard,
  useTeamParts,
} from "../../team/teamStore";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Badge } from "../ui/badge";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { SharedChatComposer, SharedChatReadBar } from "./SharedChatBars";
import { TeamAvatar } from "./TeamAvatar";

export function SharedChatView(props: { readonly chatId: number }) {
  const parts = useTeamParts();
  const list = useSharedWithMe();
  const chat = list.find((item) => item.id === props.chatId) ?? null;
  const card = useTeamCard(chat?.projectId ?? null);
  const meId = useMyUserId(parts.share);
  const feed = useSharedChatFeed(parts.share ? props.chatId : null);
  const owner = personFromCard(card.data, chat?.owner ?? null);
  const ownerName = firstName(owner);
  const level = feed.myLevel ?? chat?.myLevel ?? "read";
  const title = feed.title || chat?.title || "Shared chat";
  const computer = chat?.computer || "their computer";

  const nameOf = useMemo(() => {
    const members = card.data?.members ?? [];
    return (authorId: number | null): TeamPersonRef | null => {
      if (authorId === null) return null;
      const member = members.find((item) => item.user_id === authorId);
      return member
        ? { userId: member.user_id, email: member.email, username: member.username }
        : { userId: authorId, email: null, username: "" };
    };
  }, [card.data]);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [feed.events, feed.status]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
          {chat?.projectName ? (
            <Badge variant="outline" className="max-w-40 shrink-0 overflow-hidden">
              <span className="min-w-0 truncate">{chat.projectName}</span>
            </Badge>
          ) : null}
          {parts.share && chat ? (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground"
              data-testid="shared-chat-chip"
              title={`${ownerName} shared this chat with you. It runs on ${possessive(ownerName)} ${computer}.`}
            >
              <TeamAvatar person={owner} className="size-4" />
              <span className="text-foreground">{possessive(ownerName)} chat</span>
              <span>·</span>
              {level === "write" ? (
                <PencilIcon className="size-3" />
              ) : (
                <EyeIcon className="size-3" />
              )}
              {shareLevelLabel(level)}
            </span>
          ) : null}
        </header>
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div
            className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6"
            data-testid="shared-feed"
          >
            {!parts.share || feed.gone ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                This chat isn't shared with you any more.
              </p>
            ) : !feed.loaded ? (
              <div className="flex justify-center py-12">
                <Spinner className="size-4" />
              </div>
            ) : (
              <RemoteImagesOffContext.Provider value>
                {feed.events.map((event) => (
                  <FeedRow
                    key={event.pos}
                    event={event}
                    author={nameOf(event.authorId)}
                    meId={meId}
                  />
                ))}
                {feed.status === "running" ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    {possessive(ownerName)} agent is working on {computer}
                  </p>
                ) : feed.status === "waiting" ? (
                  <p className="text-xs text-muted-foreground">Waiting for {ownerName}</p>
                ) : null}
                {feed.error ? (
                  <p className="text-xs text-muted-foreground">
                    Not updating right now: {feed.error}
                  </p>
                ) : null}
              </RemoteImagesOffContext.Provider>
            )}
          </div>
        </div>
        {parts.share && chat && !feed.gone ? (
          <div className="mx-auto w-full max-w-4xl shrink-0 px-4 pb-4">
            {level === "write" ? (
              <SharedChatComposer chatId={props.chatId} ownerName={ownerName} computer={computer} />
            ) : (
              <SharedChatReadBar
                chat={chat}
                owner={owner}
                ownerName={ownerName}
                computer={computer}
                events={feed.events}
                title={title}
                nameOf={(authorId) => personName(nameOf(authorId))}
              />
            )}
          </div>
        ) : null}
      </div>
    </SidebarInset>
  );
}

const FeedRow = memo(function FeedRow(props: {
  readonly event: FeedEvent;
  readonly author: TeamPersonRef | null;
  readonly meId: number | null;
}) {
  const { event } = props;
  if (event.role === "activity") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
        <TerminalIcon className="size-3" aria-hidden />
        {event.text}
      </p>
    );
  }
  if (event.role === "assistant") {
    return (
      <div className="min-w-0 text-sm" data-testid="shared-feed-assistant">
        <ChatMarkdown text={event.text} cwd={undefined} />
      </div>
    );
  }
  const colleague = event.role === "colleague";
  const mine = colleague && props.author?.userId === props.meId;
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[80%] min-w-0 rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words",
          colleague ? "border border-dashed border-info/30 bg-info/4" : "bg-secondary",
        )}
      >
        {colleague ? (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <TeamAvatar person={props.author} className="size-4" />
            <span className="text-foreground">{mine ? "You" : personName(props.author)}</span>
          </div>
        ) : null}
        {event.text}
      </div>
    </div>
  );
});
