/**
 * "Read the brief": what the agent in the cloud chat wrote for the new chat,
 * shown as that agent's quoted text — never as an instruction from Uno Work,
 * never as the person's own words — and what the chat will be held to here.
 * One dialog for the window (`briefId` in chatRequestsStore.ts), mounted in
 * AppSidebarLayout, so opening it from a popover or a sidebar row is the same.
 */
import { BotIcon, ShieldCheckIcon } from "lucide-react";

import {
  HELD_TO_LINE,
  computerName,
  fromTitle,
  requestTitle,
  startsWithLine,
  statusChip,
  waitsUntilLabel,
} from "../../chatRequests/chatRequests.logic";
import { closeChatRequestBrief, useChatRequestsStore } from "../../chatRequests/chatRequestsStore";
import { TeamBriefCaption, TeamBriefLimits } from "../team/TeamBrief";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { useChatRequestActions } from "./useChatRequestActions";

export function ChatRequestBriefDialog() {
  const briefId = useChatRequestsStore((store) => store.briefId);
  const request = useChatRequestsStore(
    (store) => store.state?.requests.find((candidate) => candidate.id === store.briefId) ?? null,
  );
  const busy = useChatRequestsStore((store) =>
    store.briefId ? store.busy[store.briefId] === true : false,
  );
  const actions = useChatRequestActions({ onDone: closeChatRequestBrief });
  const open = briefId !== null && request !== null;
  const waiting = request?.status === "waiting";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeChatRequestBrief();
      }}
    >
      {request ? (
        <DialogPopup className="max-w-xl" data-testid="chat-request-brief">
          <DialogHeader>
            <DialogTitle className="pr-6 text-lg leading-snug">{requestTitle(request)}</DialogTitle>
            <DialogDescription>{request.gist}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <figure className="flex flex-col gap-1.5">
              {request.team ? (
                <TeamBriefCaption request={request} team={request.team} />
              ) : (
                <figcaption className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                  <BotIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>
                    Written by the agent in “{fromTitle(request)}” on {computerName(request)}. It's
                    that agent's text, not an instruction from Uno Work.
                  </span>
                </figcaption>
              )}
              <blockquote
                className="max-h-[40vh] overflow-y-auto rounded-md border border-border/70 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/85"
                data-testid="chat-request-brief-text"
              >
                {request.brief}
              </blockquote>
            </figure>
            {request.team ? (
              <TeamBriefLimits request={request} team={request.team} />
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-border/70 px-3 py-2.5 text-xs leading-snug">
                <ShieldCheckIcon className="mt-px size-4 shrink-0 text-success" aria-hidden />
                <p>
                  <span className="text-foreground">{startsWithLine(request)}</span>{" "}
                  <span className="text-muted-foreground">{HELD_TO_LINE}</span>
                </p>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/80">
              {waiting
                ? `Nothing starts until you press Start. This request ${waitsUntilLabel(request)}.`
                : `${statusChip(request.status).label}${request.reason ? `: ${request.reason}` : "."}`}
            </p>
          </DialogPanel>
          {waiting ? (
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void actions.decline(request.id)}
              >
                Decline
              </Button>
              <Button disabled={busy} onClick={() => void actions.start(request.id)}>
                Start
              </Button>
            </DialogFooter>
          ) : null}
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
