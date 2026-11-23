/**
 * Chat requests from the cloud at the top of Needs you (the bell, the rail's
 * Inbox, Home), next to the deploy-window cards: a chat on one of the
 * person's cloud computers asks to start a chat on this one
 * (chatRequests/). Only waiting ones; what was decided is in Settings →
 * Computer. Start opens the new chat, Decline says no, "Read the brief" shows
 * what the cloud agent wrote.
 */
import type { ChatRequestView } from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { memo } from "react";

import {
  folderLabel,
  harnessLabel,
  requestTitle,
  ownWaitingRequests,
  waitsUntilLabel,
} from "../../chatRequests/chatRequests.logic";
import { openChatRequestBrief, useChatRequestsStore } from "../../chatRequests/chatRequestsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import { useChatRequestActions } from "../chatRequests/useChatRequestActions";
import { Button } from "../ui/button";

export const ChatRequestCards = memo(function ChatRequestCards(props: {
  readonly className?: string;
  /** Start opened the chat, or the brief opened: a popover around the list closes. */
  readonly onOpened?: () => void;
}) {
  const state = useChatRequestsStore((store) => store.state);
  const busy = useChatRequestsStore((store) => store.busy);
  // "waits until" and requests running out.
  useMinuteClock();
  const requests = ownWaitingRequests(state);
  const actions = useChatRequestActions(props.onOpened ? { onDone: props.onOpened } : undefined);
  if (requests.length === 0) return null;
  return (
    <section
      aria-label="Chats from the cloud"
      className={cn("flex flex-col gap-1 px-1 pb-1.5", props.className)}
      data-testid="chat-requests"
    >
      <div className="flex h-6 items-center gap-1 pl-1">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          Chats from the cloud
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {requests.map((request) => (
          <ChatRequestCard
            key={request.id}
            request={request}
            busy={busy[request.id] === true}
            onStart={() => void actions.start(request.id)}
            onDecline={() => void actions.decline(request.id)}
            onOpenBrief={() => {
              props.onOpened?.();
              openChatRequestBrief(request.id);
            }}
          />
        ))}
      </ul>
    </section>
  );
});

function ChatRequestCard(props: {
  request: ChatRequestView;
  busy: boolean;
  onStart: () => void;
  onDecline: () => void;
  onOpenBrief: () => void;
}) {
  const { request } = props;
  return (
    <li
      className="list-none rounded-lg border border-warning/40 bg-warning/5 px-2.5 py-2"
      data-testid={`chat-request-card-${request.id}`}
    >
      <div className="flex items-start gap-2">
        <MessageSquarePlusIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm leading-snug font-medium break-words">
            {requestTitle(request)}
          </span>
          <span className="line-clamp-3 text-xs leading-snug break-words text-foreground/80">
            {request.gist}
          </span>
          <span className="truncate text-[11px] text-muted-foreground/80">
            {folderLabel(request.cwd)} · {harnessLabel(request.provider)} ·{" "}
            {waitsUntilLabel(request)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 pt-2 pl-6">
        <Button size="xs" disabled={props.busy} onClick={props.onStart}>
          Start
        </Button>
        <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onDecline}>
          Decline
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onOpenBrief}>
          Read the brief
        </Button>
      </div>
    </li>
  );
}
