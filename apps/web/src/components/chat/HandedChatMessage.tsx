/**
 * "Hand to…" (T63, Misha 24.11) in the handler's chat: the brief the person
 * handed over shows as one card (about / now / expected, Open chat, Take
 * back), not a wall of text; a note — taken back, handed elsewhere, the
 * person wrote there, back with you — as one quiet line.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  HANDED_BRIEF_PREFIX,
  HANDED_NOTE_PREFIX,
  parseHandedBrief,
  parseHandedNote,
  parseHandedReply,
} from "@t3tools/shared/handedChat";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRightLeftIcon, BotIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { setThreadHandedTo } from "../../agentsAccess";
import { HAND_TO_COPY } from "../../handTo.logic";
import { useDevMode } from "../../devMode";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";

/**
 * A chat handed here from another computer (T63-C) lives there: the
 * connected computer of that name, or null when it isn't connected.
 */
function useComputerEnvironmentId(
  computer: string | null,
  fallback: EnvironmentId | null | undefined,
): EnvironmentId | null {
  const labels = useMachineLabels();
  return useMemo(() => {
    if (computer === null) return fallback ?? null;
    for (const [environmentId, label] of labels) {
      if (label === computer) return environmentId as EnvironmentId;
    }
    return null;
  }, [computer, fallback, labels]);
}

/** Whether a user message is a hand-to brief or note (shown by HandedChatMessage). */
export const isHandedChatText = (text: string): boolean =>
  text.startsWith(HANDED_BRIEF_PREFIX) ||
  text.startsWith(HANDED_NOTE_PREFIX) ||
  parseHandedReply(text) !== null;

export const HandedChatMessage = memo(function HandedChatMessage(props: {
  readonly text: string;
  readonly environmentId: EnvironmentId | null | undefined;
}) {
  const devMode = useDevMode();
  const brief = parseHandedBrief(props.text);
  if (brief) {
    return <HandoverCard brief={brief} environmentId={props.environmentId} raw={props.text} />;
  }
  const reply = parseHandedReply(props.text);
  if (reply) return <HandedReply reply={reply} environmentId={props.environmentId} />;
  const note = parseHandedNote(props.text);
  if (!note) return null;
  return (
    <div className="flex justify-center px-4" data-testid="handed-chat-note" data-kind={note.kind}>
      <p
        className="max-w-[80%] text-center text-xs text-muted-foreground"
        title={devMode ? props.text : undefined}
      >
        {note.line}
      </p>
    </div>
  );
});

/** What the agent of a chat handled here wrote from another computer (T63-C). */
function HandedReply(props: {
  readonly reply: NonNullable<ReturnType<typeof parseHandedReply>>;
  readonly environmentId: EnvironmentId | null | undefined;
}) {
  const { reply } = props;
  const navigate = useNavigate();
  const chatEnvironmentId = useComputerEnvironmentId(reply.computer, props.environmentId);
  const label = `From the agent in “${reply.title}” on ${reply.computer}`;
  return (
    <div className="group flex justify-end" data-testid="handed-reply">
      <div className="relative flex max-w-[80%] min-w-0 flex-col items-end">
        <div className="w-full min-w-0 rounded-2xl border border-dashed border-info/30 bg-info/4 px-3.5 py-2">
          <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <BotIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
            {chatEnvironmentId && reply.threadId ? (
              <button
                type="button"
                title="Open the chat this message came from"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: chatEnvironmentId,
                      threadId: reply.threadId as ThreadId,
                    },
                  })
                }
                className="cursor-pointer truncate rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
              >
                {label}
              </button>
            ) : (
              <span className="truncate">{label}</span>
            )}
          </div>
          <p className="text-sm whitespace-pre-wrap wrap-break-word text-foreground">
            {reply.text}
          </p>
        </div>
      </div>
    </div>
  );
}

function HandoverCard(props: {
  readonly brief: NonNullable<ReturnType<typeof parseHandedBrief>>;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly raw: string;
}) {
  const { brief } = props;
  // Handed here from another computer (T63-C): the chat lives there.
  const environmentId = useComputerEnvironmentId(brief.computer, props.environmentId);
  const navigate = useNavigate();
  const devMode = useDevMode();
  const [busy, setBusy] = useState(false);
  const threadId = brief.threadId as ThreadId;
  // Still handed to this chat? (Take back only while it is.)
  const here = useParams({ strict: false }).threadId as string | undefined;
  const handedHere = useStore((store) => {
    if (!environmentId || !threadId) return false;
    const summary = selectSidebarThreadSummaryByRef(store, { environmentId, threadId });
    return summary?.handler != null && (here === undefined || summary.handler.threadId === here);
  });
  const row = (label: string, value: string) =>
    value ? (
      <>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 wrap-break-word text-foreground/90">{value}</dd>
      </>
    ) : null;
  return (
    <div className="flex justify-center px-4" data-testid="handover-card">
      <div
        className="w-full max-w-xl rounded-xl border border-border bg-muted/30 px-4 py-3"
        title={devMode ? props.raw : undefined}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ArrowRightLeftIcon className="size-3.5 shrink-0" aria-hidden />
          <span>
            {brief.computer
              ? `You handed a chat on ${brief.computer} here · this chat handles it now`
              : "You handed a chat here · this chat handles it now"}
          </span>
        </div>
        <div className="mt-1.5 text-sm font-medium text-foreground">“{brief.title}”</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          {row("About", brief.about)}
          {row("Now", brief.now)}
          {row("Expected", brief.expected)}
        </dl>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 pt-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Its Ready and questions come here · approvals still go to you
          </span>
          {environmentId && threadId ? (
            <button
              type="button"
              className="cursor-pointer font-medium text-foreground hover:underline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId },
                })
              }
            >
              Open chat
            </button>
          ) : null}
          {environmentId && threadId && handedHere ? (
            <button
              type="button"
              disabled={busy}
              data-testid="handover-take-back"
              className="cursor-pointer hover:text-foreground hover:underline disabled:opacity-50"
              onClick={() => {
                setBusy(true);
                void setThreadHandedTo({ environmentId, threadId, handler: null }).finally(() =>
                  setBusy(false),
                );
              }}
            >
              {HAND_TO_COPY.takeBack}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
