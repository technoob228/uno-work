/**
 * T51 (b): "From your team" at the top of Needs you (the bell, the rail's
 * Inbox, Home), above T50's chats from the cloud.
 *
 * - A colleague's session request is a T50 request with `team` (the daemon
 *   holds it): Start / Decline / Read the brief, the same path as T50.
 * - A message, a question, "may I write" come from `requests/inbox` (the
 *   cloud): Reply / Got it, Answer myself / Let my agent answer, Allow / Decline.
 *
 * Nothing while the parts are off or nothing waits.
 */
import type { ChatRequestView, EnvironmentId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useState } from "react";

import { teamWaitingRequests, waitsUntilLabel } from "../../chatRequests/chatRequests.logic";
import { openChatRequestBrief, useChatRequestsStore } from "../../chatRequests/chatRequestsStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import { loadProjectChats, sendPersonRequest } from "../../team/teamApi";
import { teamCollabErrorMessage, type TeamRequest } from "../../team/teamApi.logic";
import { firstName, possessive, requestHeadline, teamSessionHeadline } from "../../team/team.logic";
import { teamDaemonRefresh, teamLetAgentAnswer, teamRpcAvailable } from "../../team/teamRpc";
import {
  decideTeamRequest,
  refreshTeamInbox,
  setTeamInboxBusy,
  teamChatsQueryKey,
  useTeamInboxStore,
  useTeamInboxWaiting,
  useTeamParts,
} from "../../team/teamStore";
import { useChatRequestActions } from "../chatRequests/useChatRequestActions";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TeamAvatar, personOf } from "./TeamAvatar";

export const TeamRequestCards = memo(function TeamRequestCards(props: {
  readonly className?: string;
  /** Start opened the chat, or the brief opened: a popover around the list closes. */
  readonly onOpened?: () => void;
}) {
  const parts = useTeamParts();
  const state = useChatRequestsStore((store) => store.state);
  const busy = useChatRequestsStore((store) => store.busy);
  useMinuteClock();
  const sessions = parts.requests ? teamWaitingRequests(state) : [];
  const inbox = useTeamInboxWaiting();
  const actions = useChatRequestActions(props.onOpened ? { onDone: props.onOpened } : undefined);
  if (sessions.length + inbox.length === 0) return null;
  const projects = new Set([
    ...sessions.map((request) => request.team?.projectName ?? ""),
    ...inbox.map((request) => request.projectName),
  ]);
  const project = projects.size === 1 ? [...projects][0] : "";
  return (
    <section
      aria-label="From your team"
      className={cn("flex flex-col gap-1 px-1 pb-1.5", props.className)}
      data-testid="team-requests"
    >
      <div className="flex h-6 items-center gap-1 pl-1">
        <span className="flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          From your team{project ? ` · ${project}` : ""}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {sessions.map((request) => (
          <TeamSessionCard
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
        {inbox.map((request) => (
          <TeamInboxCard key={request.id} request={request} />
        ))}
      </ul>
    </section>
  );
});

function CardShell(props: {
  readonly testId: string;
  readonly urgent: boolean;
  readonly avatar: React.ReactNode;
  readonly title: string;
  readonly text: string;
  readonly meta: string;
  readonly children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "list-none rounded-lg border px-2.5 py-2",
        props.urgent ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
      data-testid={props.testId}
    >
      <div className="flex items-start gap-2">
        {props.avatar}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm leading-snug font-medium break-words">
            {props.title}
          </span>
          {props.text ? (
            <span className="line-clamp-3 text-xs leading-snug break-words whitespace-pre-wrap text-foreground/80">
              {props.text}
            </span>
          ) : null}
          <span className="truncate text-[11px] text-muted-foreground/80">{props.meta}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 pt-2 pl-8">{props.children}</div>
    </li>
  );
}

function TeamSessionCard(props: {
  readonly request: ChatRequestView;
  readonly busy: boolean;
  readonly onStart: () => void;
  readonly onDecline: () => void;
  readonly onOpenBrief: () => void;
}) {
  const { request } = props;
  const team = request.team;
  if (!team) return null;
  const chat = request.from.threadTitle.trim();
  const meta = [
    team.projectName,
    chat ? `from the chat “${chat}”` : "",
    waitsUntilLabel(request),
  ].filter(Boolean);
  return (
    <CardShell
      testId={`team-session-${request.id}`}
      urgent
      avatar={
        <TeamAvatar
          person={personOf(team.fromUserId, team.fromName)}
          agent={team.viaAgent}
          className="mt-0.5 size-6"
        />
      }
      title={teamSessionHeadline(team)}
      text={request.title ? `${request.title}: ${request.gist}` : request.gist}
      meta={meta.join(" · ")}
    >
      <div className="flex flex-wrap items-center gap-1">
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
    </CardShell>
  );
}

function agoLabel(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function TeamInboxCard(props: { readonly request: TeamRequest }) {
  const { request } = props;
  const busy = useTeamInboxStore((store) => store.busy[request.id] === true);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const name = firstName(request.from);

  const fail = (title: string, message: string | null) => {
    if (message) toastManager.add({ type: "error", title, description: message });
    return message === null;
  };

  const reply = async () => {
    const message = text.trim();
    if (!message || !request.from) return;
    setTeamInboxBusy(request.id, true);
    try {
      await sendPersonRequest({
        projectId: request.projectId,
        to: request.from.userId,
        kind: "message",
        ...(request.title ? { title: `Re: ${request.title}`.slice(0, 120) } : {}),
        text: message,
      });
    } catch (error) {
      setTeamInboxBusy(request.id, false);
      fail("Not sent", teamCollabErrorMessage(error));
      return;
    }
    setTeamInboxBusy(request.id, false);
    if (fail("Sent, but not marked read", await decideTeamRequest(request, "read"))) {
      toastManager.add({ type: "success", title: `Sent to ${name}` });
    }
  };

  const answerMyself = async () => {
    const message = text.trim();
    if (!message) return;
    if (fail("Not sent", await decideTeamRequest(request, "answer", message))) {
      toastManager.add({ type: "success", title: `${name} gets your answer` });
    }
  };

  const letAgentAnswer = async () => {
    setTeamInboxBusy(request.id, true);
    const error = await teamLetAgentAnswer(primaryEnvironmentId, request.id);
    setTeamInboxBusy(request.id, false);
    if (fail("Your agent can't answer", error)) {
      toastManager.add({
        type: "success",
        title: "Your agent answers",
        description: `Its answer goes to ${name}. You see it in the project's journal.`,
      });
      void refreshTeamInbox();
    }
  };

  const allowWrite = async () => {
    if (!request.from) return;
    // The server's "allow" sets the share to write itself (and wakes the
    // daemon): no separate PUT, so write never lands while the request still
    // waits. This computer's Work is told at once (team.refresh) too.
    if (!fail("Couldn't allow", await decideTeamRequest(request, "allow"))) return;
    toastManager.add({ type: "success", title: `${name} can write in your chat` });
    await queryClient.invalidateQueries({ queryKey: teamChatsQueryKey(request.projectId) });
    try {
      const chats = await loadProjectChats(request.projectId);
      const chat = chats.mine.find((item) => item.id === request.chatId) ?? null;
      if (chat) void teamDaemonRefresh(chat.source as EnvironmentId);
    } catch {
      // The daemon hears of it on its own next round.
    }
  };

  const urgent = request.kind !== "message";
  const meta = [
    request.projectName,
    request.viaAgent && request.fromChatTitle
      ? `from ${possessive(name)} chat “${request.fromChatTitle}”`
      : "",
    agoLabel(request.createdAt),
  ].filter(Boolean);
  const body =
    request.kind === "write_access" ? request.title || request.gist : request.gist || request.body;

  return (
    <CardShell
      testId={`team-request-${request.id}`}
      urgent={urgent}
      avatar={
        <TeamAvatar person={request.from} agent={request.viaAgent} className="mt-0.5 size-6" />
      }
      title={requestHeadline(request)}
      text={body}
      meta={meta.join(" · ")}
    >
      {composing ? (
        <div className="flex flex-col gap-1">
          <Textarea
            value={text}
            autoFocus
            rows={2}
            placeholder={
              request.kind === "question" ? `Your answer to ${name}` : `Reply to ${name}`
            }
            onChange={(event) => setText(event.target.value)}
            data-testid={`team-request-text-${request.id}`}
          />
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              disabled={busy || !text.trim()}
              onClick={() => void (request.kind === "question" ? answerMyself() : reply())}
            >
              Send
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setComposing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {request.kind === "message" ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setComposing(true)}
              >
                Reply
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void decideTeamRequest(request, "read").then((m) => fail("Didn't work", m))
                }
              >
                Got it
              </Button>
            </>
          ) : request.kind === "write_access" ? (
            <>
              <Button size="xs" disabled={busy} onClick={() => void allowWrite()}>
                Allow
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void decideTeamRequest(request, "deny").then((m) => fail("Didn't work", m))
                }
              >
                Decline
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" disabled={busy} onClick={() => setComposing(true)}>
                Answer myself
              </Button>
              {teamRpcAvailable(primaryEnvironmentId) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void letAgentAnswer()}
                >
                  Let my agent answer
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </CardShell>
  );
}
