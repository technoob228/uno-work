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
} from "@t3tools/shared/handedChat";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRightLeftIcon } from "lucide-react";
import { memo, useState } from "react";

import { setThreadHandedTo } from "../../agentsAccess";
import { HAND_TO_COPY } from "../../handTo.logic";
import { useDevMode } from "../../devMode";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";

/** Whether a user message is a hand-to brief or note (shown by HandedChatMessage). */
export const isHandedChatText = (text: string): boolean =>
  text.startsWith(HANDED_BRIEF_PREFIX) || text.startsWith(HANDED_NOTE_PREFIX);

export const HandedChatMessage = memo(function HandedChatMessage(props: {
  readonly text: string;
  readonly environmentId: EnvironmentId | null | undefined;
}) {
  const devMode = useDevMode();
  const brief = parseHandedBrief(props.text);
  if (brief) {
    return <HandoverCard brief={brief} environmentId={props.environmentId} raw={props.text} />;
  }
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

function HandoverCard(props: {
  readonly brief: NonNullable<ReturnType<typeof parseHandedBrief>>;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly raw: string;
}) {
  const { brief, environmentId } = props;
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
          <span>You handed a chat here · this chat handles it now</span>
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
