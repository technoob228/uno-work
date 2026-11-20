/**
 * T51 mockup: "From your team" at the top of Needs you, next to T50's chats
 * from the cloud. A colleague's agent suggests a session on your computer
 * (T50 plus a person: Start / Decline / Read the brief); a colleague's
 * message; a chat shared with you. Demo data only (team/teamCollab.ts).
 */
import { useNavigate } from "@tanstack/react-router";
import { ShieldAlertIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  agentLevelLabel,
  decideTeamRequest,
  firstName,
  openTeamBrief,
  personById,
  useTeamCollab,
  type TeamRequest,
} from "../../team/teamCollab";
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
import { TeamAvatar } from "./TeamAvatar";

function headline(request: TeamRequest, name: string): string {
  switch (request.kind) {
    case "session":
      return request.viaAgentChat
        ? `${name} and his agent suggest starting a session here`
        : `${name} suggests starting a session here`;
    case "write-access":
      return `${name} asks to write in your chat`;
    case "shared":
      return `${name} shared a chat with you`;
    case "message":
      return name;
  }
}

export const TeamRequestCards = memo(function TeamRequestCards(props: {
  readonly className?: string;
  readonly onOpened?: () => void;
}) {
  const state = useTeamCollab();
  const navigate = useNavigate();
  const waiting = state.requests.filter((request) => request.status === "waiting");
  if (!state.enabled || waiting.length === 0) return null;
  return (
    <section
      aria-label="From your team"
      className={cn("flex flex-col gap-1 px-1 pb-1.5", props.className)}
      data-testid="team-requests"
    >
      <div className="flex h-6 items-center gap-1 pl-1">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          From your team · {state.project}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {waiting.map((request) => {
          const from = personById(state, request.fromPersonId);
          const name = firstName(from);
          const urgent = request.kind === "session" || request.kind === "write-access";
          return (
            <li
              key={request.id}
              className={cn(
                "list-none rounded-lg border px-2.5 py-2",
                urgent ? "border-warning/40 bg-warning/5" : "border-border bg-card",
              )}
              data-testid={`team-request-${request.id}`}
            >
              <div className="flex items-start gap-2">
                <TeamAvatar
                  person={from}
                  agent={request.viaAgentChat !== null}
                  className="mt-0.5 size-6"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="line-clamp-2 text-sm leading-snug font-medium break-words">
                    {headline(request, name)}
                  </span>
                  <span className="line-clamp-3 text-xs leading-snug break-words text-foreground/80">
                    {request.kind === "session" ? `${request.title}: ` : ""}
                    {request.gist}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground/80">
                    {request.kind === "session"
                      ? `${request.project} · on ${request.computer} · from his chat “${request.viaAgentChat}” · waits 2 h`
                      : `${request.project} · ${request.minutesAgo} min ago`}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 pt-2 pl-8">
                {request.kind === "session" ? (
                  <>
                    <Button size="xs" onClick={() => decideTeamRequest(request.id, "started")}>
                      Start
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => decideTeamRequest(request.id, "declined")}
                    >
                      Decline
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        props.onOpened?.();
                        openTeamBrief(request.id);
                      }}
                    >
                      Read the brief
                    </Button>
                  </>
                ) : request.kind === "shared" ? (
                  <Button
                    size="xs"
                    onClick={() => {
                      props.onOpened?.();
                      decideTeamRequest(request.id, "read");
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: "env-demo-uno-work", threadId: "t-stripe" },
                      });
                    }}
                  >
                    Open
                  </Button>
                ) : (
                  <>
                    <Button size="xs" variant="outline">
                      Reply
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => decideTeamRequest(request.id, "read")}
                    >
                      Got it
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

/** "Read the brief": the colleague's agent's text, quoted as theirs, and what the session can't do. */
export const TeamRequestBriefDialog = memo(function TeamRequestBriefDialog() {
  const state = useTeamCollab();
  const request = state.requests.find((item) => item.id === state.briefId) ?? null;
  const from = request ? personById(state, request.fromPersonId) : null;
  const name = firstName(from);
  const level = request ? (state.levelFor[request.fromPersonId] ?? state.defaultLevel) : "ask";
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open ? null : openTeamBrief(null))}>
      {request ? (
        <DialogPopup className="max-w-xl" data-testid="team-request-brief">
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
            <DialogDescription>
              {name}'s agent wants a session on your {request.computer}, in {request.project}. It
              starts only when you press Start.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TeamAvatar person={from} agent className="size-5" />
                Written by {name}'s agent in his chat “{request.viaAgentChat}”, not by Uno Work or
                by you
              </div>
              <blockquote className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
                {request.brief}
              </blockquote>
            </div>
            <div className="rounded-md border border-border p-3 text-xs">
              <div className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
                <ShieldAlertIcon className="size-3.5 text-warning" />
                In this session your agent can't
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                <li>deploy, git push, ssh, sudo or install anything</li>
                <li>read or send keys and .env — Stripe works through its own sign-in</li>
                <li>leave the landing folder or open your other projects</li>
                <li>send {name} anything but its last message, which you see first</li>
              </ul>
              <p className="mt-2 text-muted-foreground">
                Your setting for {name}'s agent:{" "}
                <span className="text-foreground">{agentLevelLabel(level)}</span>. Text from {name}
                's agent counts as text from outside: Uno Work tools ask you first.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => decideTeamRequest(request.id, "declined")}>
              Decline
            </Button>
            <Button onClick={() => decideTeamRequest(request.id, "started")}>Start</Button>
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
});
