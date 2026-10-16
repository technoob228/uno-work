/**
 * The chat folded while a panel tab has the whole window (w0138 p3).
 *
 * - "mini": a small pill in the corner — status dot, chat name, "Working…" /
 *   "Your turn". A reply of the agent pops up over it as a hint (first line +
 *   Reply / Open chat) and hides itself after a few seconds, leaving an unread
 *   dot; an approval the agent waits for stays up with Approve / Deny.
 * - "column": the same chat as a narrow column on the right (to compare): the
 *   tab gives it room, the messages and an approval are always in view.
 *
 * A click on the pill (or ⤢ in the column) brings the chat back to the bottom.
 */
import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import { Maximize2Icon, MessageSquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import {
  CHAT_DOCK_HINT_MS,
  CHAT_DOCK_STATUS_LABEL,
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
  pendingApproval: { requestId: ApprovalRequestId; detail?: string | undefined } | null;
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
  const latestReply = useMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index]!;
      if (message.role === "assistant") return message;
    }
    return null;
  }, [props.messages]);
  // What was on screen when the chat folded counts as seen.
  const [seenReplyId, setSeenReplyId] = useState<string | null>(() => latestReply?.id ?? null);
  const [hint, setHint] = useState<ChatDockNotice | null>(null);
  const [unread, setUnread] = useState(false);

  const notice = nextChatDockNotice({
    pendingApproval: props.pendingApproval,
    latestReply,
    seenReplyId,
  });

  const noticeKind = notice?.kind ?? null;
  const noticeId = notice?.id ?? null;
  const noticeText = notice?.text ?? "";
  useEffect(() => {
    if (noticeKind === null || noticeId === null) {
      // The approval was answered (here or elsewhere): its hint goes away.
      setHint((current) => (current?.kind === "approval" ? null : current));
      return;
    }
    const next: ChatDockNotice = { kind: noticeKind, id: noticeId, text: noticeText };
    setHint((current) => (current?.id === next.id && current.text === next.text ? current : next));
    setUnread(true);
    if (next.kind === "reply") setSeenReplyId(next.id);
  }, [noticeKind, noticeId, noticeText]);

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

function ApprovalButtons({
  requestId,
  responding,
  onRespond,
  size = "xs",
}: {
  requestId: ApprovalRequestId;
  responding: boolean;
  onRespond: ChatMiniWindowProps["onRespondToApproval"];
  size?: "xs" | "sm";
}) {
  return (
    <>
      <Button
        size={size}
        variant="outline"
        disabled={responding}
        onClick={() => void onRespond(requestId, "decline")}
      >
        Deny
      </Button>
      <Button
        size={size}
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
      className="pointer-events-none fixed right-4 z-[70] flex flex-col items-end gap-2"
      // In the demo the "what to look at" pill sits in the same corner.
      style={{ bottom: "1rem" }}
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
              <button
                type="button"
                onClick={dismissHint}
                aria-label="Hide"
                className="-mr-1 inline-flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
          {hint.kind === "approval" ? (
            <>
              <div className="mt-1.5 font-medium text-sm">Wants to run</div>
              <div
                className="mt-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs"
                title={hint.text}
              >
                {hint.text}
              </div>
            </>
          ) : (
            <div className="mt-1 line-clamp-2 text-sm leading-5">{hint.text}</div>
          )}
          <div className="mt-2.5 flex items-center justify-end gap-1.5">
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
        title="Show the chat"
        aria-label={`Show the chat: ${props.title} · ${label}${unread ? " · new reply" : ""}`}
        data-chat-mini-pill="true"
        className="pointer-events-auto flex h-9 max-w-[22rem] cursor-pointer items-center gap-2 rounded-full border border-border/70 bg-card/95 pl-3 pr-2.5 shadow-lg shadow-black/10 backdrop-blur-xl hover:bg-card"
      >
        <ChatDockStatusDot status={props.status} />
        <span className="min-w-0 truncate font-medium text-[13px]">{props.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
        {unread ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
        <Maximize2Icon className="size-3.5 shrink-0 text-muted-foreground" />
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
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-border border-b pl-3.5 pr-2 fullscreen:h-9">
        <ChatDockStatusDot status={props.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[13px] leading-4">{props.title}</div>
          <div className="truncate text-muted-foreground text-[11px] leading-4">{label}</div>
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
          <Maximize2Icon />
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
          <div className="font-medium text-[13px]">Wants to run</div>
          <div className="mt-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">
            {props.pendingApproval.detail ?? "A step that needs your OK"}
          </div>
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
