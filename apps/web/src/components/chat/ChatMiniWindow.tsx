/**
 * The chat hidden while a panel tab has the whole window (w0138 p3).
 *
 * - "mini": a small pill in the corner — status dot, chat name, "Working…" /
 *   "Your turn". When the agent hands the turn back, its reply pops up over the
 *   pill as a hint (first line + Reply / Open chat) and hides itself after a
 *   few seconds, leaving an unread dot; an approval the agent waits for stays
 *   up with Approve / Deny.
 * - "column": the same chat as a narrow column on the right (to compare): the
 *   tab gives it room, the messages and an approval are always in view.
 *
 * Everything here reads the chat's own events (messages, pending approvals,
 * the turn state) — the same in the demo and with a real agent.
 */
import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { MessageSquareIcon, PanelBottomOpenIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import {
  CHAT_DOCK_HINT_MS,
  CHAT_DOCK_STATUS_LABEL,
  chatDockApprovalPhrase,
  chatDockInitialSeenReplyId,
  chatDockLatestReply,
  nextChatDockNotice,
  type ChatDockNotice,
  type ChatDockStatus,
} from "./chatDock.logic";
import { ChatDockMessages, ChatDockStatusDot } from "./FullscreenChatDock";

type DockMessage = Pick<ChatMessage, "id" | "role" | "text" | "streaming">;

export interface ChatMiniWindowProps {
  variant: "mini" | "column";
  title: string;
  status: ChatDockStatus;
  /** The last messages of the chat (oldest first). */
  messages: ReadonlyArray<DockMessage>;
  pendingApproval: {
    requestId: ApprovalRequestId;
    requestKind: "command" | "file-read" | "file-change" | "other";
    detail?: string | undefined;
  } | null;
  approvalResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  /** Back to the dense block at the bottom. */
  onRestore: () => void;
  /** Back to the bottom with the cursor in the composer. */
  onReply: () => void;
  /** Leave full screen: the chat next to the panel. */
  onOpenChat: () => void;
}

/** Width of the column variant; the full-screen tab leaves this much room on the right. */
export const CHAT_DOCK_COLUMN_WIDTH = "20rem";
const COLUMN_VAR = "--chat-dock-column-width";

function useDockNotice(props: ChatMiniWindowProps) {
  const isWorking = props.status === "working";
  // What was on screen when the chat was hidden counts as seen (a reply still
  // being written doesn't: it pops up once it's done).
  const [seenReplyId, setSeenReplyId] = useState<string | null>(() =>
    chatDockInitialSeenReplyId(props.messages),
  );
  const [hint, setHint] = useState<ChatDockNotice | null>(null);
  const [unread, setUnread] = useState(false);

  const notice = nextChatDockNotice({
    pendingApproval: props.pendingApproval,
    messages: props.messages,
    isWorking,
    seenReplyId,
  });
  // Re-run only when what the hint says changes, not on every new array.
  const noticeKey = notice ? `${notice.kind}:${notice.id}:${notice.text}` : "";
  const latestReplyId = chatDockLatestReply(props.messages)?.id ?? null;
  const noticeRef = useRef(notice);
  noticeRef.current = notice;

  useEffect(() => {
    const next = noticeRef.current;
    if (!next) {
      // The approval was answered (here or elsewhere): its hint goes away.
      setHint((current) => (current?.kind === "approval" ? null : current));
      return;
    }
    setHint(next);
    setUnread(true);
    // The agent's words before an approval are part of the approval hint:
    // they don't pop up again as a reply after the answer.
    setSeenReplyId(next.kind === "reply" ? next.id : latestReplyId);
  }, [noticeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hint || hint.kind !== "reply") return;
    const timer = window.setTimeout(() => setHint(null), CHAT_DOCK_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  return {
    hint,
    dismissHint: () => setHint(null),
    unread,
    // The person answered from the hint: they've seen it.
    markRead: () => setUnread(false),
  };
}

/** The command of an approval, whole: behind "Show command", three lines, then "Show all". */
function ApprovalCommand({ command }: { command: string | null }) {
  const [shown, setShown] = useState(false);
  const [all, setAll] = useState(false);
  if (!command) return null;
  const long = command.length > 140 || command.split("\n").length > 3;
  if (!shown) {
    return (
      <Button
        size="xs"
        variant="link"
        className="-ml-2 h-6 text-muted-foreground"
        onClick={() => setShown(true)}
      >
        Show command
      </Button>
    );
  }
  return (
    <div className="mt-1.5">
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 font-mono text-xs leading-4",
          !all && "line-clamp-3",
        )}
      >
        {command}
      </pre>
      {long ? (
        <Button
          size="xs"
          variant="link"
          className="-ml-2 h-6 text-muted-foreground"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

function ApprovalButtons({
  requestId,
  responding,
  onRespond,
}: {
  requestId: ApprovalRequestId;
  responding: boolean;
  onRespond: ChatMiniWindowProps["onRespondToApproval"];
}) {
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={responding}
        onClick={() => void onRespond(requestId, "decline")}
      >
        Deny
      </Button>
      <Button
        size="xs"
        variant="default"
        disabled={responding}
        onClick={() => void onRespond(requestId, "accept")}
      >
        Approve
      </Button>
    </>
  );
}

function MiniWindow(props: ChatMiniWindowProps) {
  const { hint, dismissHint, unread, markRead } = useDockNotice(props);
  const respond: ChatMiniWindowProps["onRespondToApproval"] = (requestId, decision) => {
    markRead();
    return props.onRespondToApproval(requestId, decision);
  };
  const label = CHAT_DOCK_STATUS_LABEL[props.status];
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2"
      data-chat-mini-window="true"
    >
      {hint ? (
        <div
          role={hint.kind === "approval" ? "alertdialog" : "status"}
          aria-label={hint.kind === "approval" ? "The agent asks for your OK" : "New reply"}
          data-chat-mini-hint={hint.kind}
          className="pointer-events-auto w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border/80 bg-popover p-3 text-popover-foreground shadow-xl shadow-black/12 animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
        >
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <ChatDockStatusDot status={props.status} />
            <span className="min-w-0 flex-1 truncate">{props.title}</span>
            {hint.kind === "reply" ? (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={dismissHint}
                aria-label="Hide"
                className="-my-1 -mr-1"
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
          <div className="mt-1 line-clamp-2 text-sm leading-5">{hint.text}</div>
          {hint.kind === "approval" ? <ApprovalCommand command={hint.command} /> : null}
          <div className="mt-2 flex items-center justify-end gap-1.5">
            {hint.kind === "approval" && props.pendingApproval ? (
              <>
                <Button size="xs" variant="ghost" className="mr-auto" onClick={props.onOpenChat}>
                  Open chat
                </Button>
                <ApprovalButtons
                  requestId={props.pendingApproval.requestId}
                  responding={props.approvalResponding}
                  onRespond={respond}
                />
              </>
            ) : (
              <>
                <Button size="xs" variant="ghost" onClick={props.onOpenChat}>
                  Open chat
                </Button>
                <Button size="xs" variant="default" onClick={props.onReply}>
                  Reply
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      <button
        type="button"
        onClick={props.onRestore}
        title="Show chat"
        aria-label={`Show chat: ${props.title} · ${label}${unread ? " · new reply" : ""}`}
        data-chat-mini-pill="true"
        className="pointer-events-auto flex h-9 max-w-[22rem] cursor-pointer items-center gap-2 rounded-full border border-border/70 bg-card/95 pl-3 pr-2.5 shadow-lg shadow-black/10 backdrop-blur-xl hover:bg-card"
      >
        <ChatDockStatusDot status={props.status} />
        <span className="min-w-0 truncate font-medium text-[13px]">{props.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
        {unread ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
        <PanelBottomOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

function ColumnWindow(props: ChatMiniWindowProps) {
  const label = CHAT_DOCK_STATUS_LABEL[props.status];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The full-screen tab steps aside for the column (PreviewPane reads the variable).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(COLUMN_VAR, CHAT_DOCK_COLUMN_WIDTH);
    return () => {
      root.style.removeProperty(COLUMN_VAR);
    };
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [props.messages, props.pendingApproval]);
  return (
    <aside
      className="fixed right-0 bottom-0 top-0 z-[60] flex flex-col border-border border-l bg-background"
      style={{ width: CHAT_DOCK_COLUMN_WIDTH }}
      aria-label={`Chat: ${props.title}`}
      data-chat-dock-column="true"
    >
      {/* Same height as the full-screen tab row next to it. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-border border-b bg-card pl-3.5 pr-2 fullscreen:h-9 wco:h-[env(titlebar-area-height)]">
        <ChatDockStatusDot status={props.status} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate font-medium text-[13px]">{props.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={props.onOpenChat}
          aria-label="Open chat"
          title="Open chat"
        >
          <MessageSquareIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={props.onRestore}
          aria-label="Chat back to the bottom"
          title="Chat back to the bottom"
        >
          <PanelBottomOpenIcon />
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <ChatDockMessages messages={props.messages} className="min-h-full justify-end" />
      </div>
      {props.pendingApproval ? (
        <div
          className="shrink-0 border-border border-t bg-amber-500/5 px-3.5 py-2.5"
          data-chat-mini-hint="approval"
        >
          <div className="text-[13px] leading-5">
            {chatDockApprovalPhrase({
              requestKind: props.pendingApproval.requestKind,
              // The agent's own words are right above in the column.
              messages: [],
            })}
          </div>
          <ApprovalCommand command={props.pendingApproval.detail?.trim() || null} />
          <div className="mt-2 flex justify-end gap-1.5">
            <ApprovalButtons
              requestId={props.pendingApproval.requestId}
              responding={props.approvalResponding}
              onRespond={props.onRespondToApproval}
            />
          </div>
        </div>
      ) : null}
      <div className="shrink-0 p-2.5 pt-0">
        <button
          type="button"
          onClick={props.onReply}
          className={cn(
            "flex h-9 w-full cursor-text items-center rounded-lg border border-border/70 bg-card px-3 text-left text-muted-foreground/70 text-sm hover:border-border",
            !props.pendingApproval && "mt-2.5",
          )}
        >
          Reply…
        </button>
      </div>
    </aside>
  );
}

export function ChatMiniWindow(props: ChatMiniWindowProps) {
  return props.variant === "column" ? <ColumnWindow {...props} /> : <MiniWindow {...props} />;
}
