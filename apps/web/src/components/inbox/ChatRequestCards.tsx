/**
 * Chat requests from the cloud at the top of Needs you (the bell, the rail's
 * Inbox, Home), next to the deploy-window cards: a chat on one of the
 * person's cloud computers asks to start a chat on this one
 * (chatRequests/). Only waiting ones; what was decided is in Settings →
 * Computer. Start opens the new chat, Decline says no, "Read the brief" shows
 * what the cloud agent wrote. "Don't ask again for this chat" with Start: that
 * chat's next requests start by themselves (revoked in Settings → Computer).
 */
import type { ChatRequestView } from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import {
  folderLabel,
  harnessLabel,
  requestTitle,
  ownWaitingRequests,
  TRUST_CHAT_HINT,
  TRUST_CHAT_LABEL,
  waitsUntilLabel,
} from "../../chatRequests/chatRequests.logic";
import { openChatRequestBrief, useChatRequestsStore } from "../../chatRequests/chatRequestsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import { useChatRequestActions } from "../chatRequests/useChatRequestActions";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

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
            onStart={(trustChat) => void actions.start(request.id, trustChat)}
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
  onStart: (trustChat: boolean) => void;
  onDecline: () => void;
  onOpenBrief: () => void;
}) {
  const { request } = props;
  const [trustChat, setTrustChat] = useState(false);
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
        <Button size="xs" disabled={props.busy} onClick={() => props.onStart(trustChat)}>
          Start
        </Button>
        <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onDecline}>
          Decline
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onOpenBrief}>
          Read the brief
        </Button>
      </div>
      <TrustChatToggle
        checked={trustChat}
        disabled={props.busy}
        onCheckedChange={setTrustChat}
        className="pt-1.5 pl-6"
        testId={`chat-request-trust-${request.id}`}
      />
    </li>
  );
}

/** "Don't ask again for this chat": goes with Start, here and in the brief. */
export function TrustChatToggle(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly className?: string;
  readonly testId?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-1.5", props.className)}>
      <Checkbox
        id={id}
        checked={props.checked}
        disabled={props.disabled === true}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
        className="mt-px"
        data-testid={props.testId}
      />
      <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5 text-[11px] leading-snug">
        <span className="text-foreground/85">{TRUST_CHAT_LABEL}</span>
        {props.checked ? <span className="text-muted-foreground/80">{TRUST_CHAT_HINT}</span> : null}
      </label>
    </div>
  );
}
