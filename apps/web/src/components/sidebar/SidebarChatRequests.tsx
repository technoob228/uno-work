/**
 * Chat requests from the cloud above the chats in the sidebar, one compact
 * row each: «<cloud chat> wants to start a chat here: <gist>», Start and
 * Decline, the text opens the brief. Nothing shows when nothing waits (and
 * never on a cloud computer — the store asks nothing there).
 */
import { CloudIcon } from "lucide-react";
import { memo } from "react";

import { fromTitle, waitingRequests } from "../../chatRequests/chatRequests.logic";
import { openChatRequestBrief, useChatRequestsStore } from "../../chatRequests/chatRequestsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { useChatRequestActions } from "../chatRequests/useChatRequestActions";
import { Button } from "../ui/button";

export const SidebarChatRequests = memo(function SidebarChatRequests() {
  const state = useChatRequestsStore((store) => store.state);
  const busy = useChatRequestsStore((store) => store.busy);
  useMinuteClock();
  const requests = waitingRequests(state);
  const actions = useChatRequestActions();
  if (requests.length === 0) return null;
  return (
    <section className="shrink-0 pb-1.5" data-testid="sidebar-chat-requests">
      <ul role="list" className="flex flex-col gap-1">
        {requests.map((request) => (
          <li
            key={request.id}
            className="list-none rounded-lg border border-warning/35 bg-warning/5 px-2 py-1.5"
            data-testid={`sidebar-chat-request-${request.id}`}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-start gap-2 text-left"
              title="Read the brief"
              onClick={() => openChatRequestBrief(request.id)}
            >
              <CloudIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="line-clamp-2 min-w-0 text-xs leading-snug text-sidebar-foreground">
                <span className="font-medium">{fromTitle(request)}</span>
                <span className="text-sidebar-foreground/75"> wants to start a chat here: </span>
                <span className="text-sidebar-muted-foreground">{request.gist}</span>
              </span>
            </button>
            <div className="flex items-center gap-1 pt-1.5 pl-5.5">
              <Button
                size="xs"
                disabled={busy[request.id] === true}
                onClick={() => void actions.start(request.id)}
              >
                Start
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy[request.id] === true}
                onClick={() => void actions.decline(request.id)}
              >
                Decline
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto text-muted-foreground"
                onClick={() => openChatRequestBrief(request.id)}
              >
                Brief
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
});
