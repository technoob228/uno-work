/**
 * The chat under a panel tab opened on the whole window (w0138 p3): the latest
 * step is the top edge of the composer's own block — one dense block, not two
 * floating pills. The chevron shows the last messages right above the
 * composer; the fold button sends the chat to a mini window (ChatMiniWindow).
 */
import { ChevronDownIcon, ChevronUpIcon, PanelBottomCloseIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";
import {
  CHAT_DOCK_STATUS_DOT,
  CHAT_DOCK_STATUS_LABEL,
  chatDockStepPreview,
  type ChatDockStatus,
} from "./chatDock.logic";

export function ChatDockStatusDot({
  status,
  className,
}: {
  status: ChatDockStatus;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {status === "working" ? (
        <span
          className={cn(
            "absolute inset-0 animate-ping rounded-full opacity-60",
            CHAT_DOCK_STATUS_DOT[status],
          )}
        />
      ) : null}
      <span className={cn("relative size-2 rounded-full", CHAT_DOCK_STATUS_DOT[status])} />
    </span>
  );
}

/** Messages of the chat, dense: the person's on the right, the agent's as plain text. */
export function ChatDockMessages({
  messages,
  className,
}: {
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text">>;
  className?: string;
}) {
  if (messages.length === 0) {
    return (
      <div className={cn("py-3 text-center text-muted-foreground text-xs", className)}>
        No messages yet
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {messages.map((message) =>
        message.role === "user" ? (
          <div
            key={message.id}
            className="ml-auto line-clamp-4 max-w-[80%] whitespace-pre-wrap break-words rounded-lg bg-muted px-2 py-1 text-[13px] leading-5 text-foreground"
          >
            {message.text.trim() || "(empty)"}
          </div>
        ) : (
          <div
            key={message.id}
            className="line-clamp-6 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90"
          >
            {message.text.trim() || "…"}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The top edge of the composer block: status dot, the latest step in one
 * muted line, show-messages chevron and fold. `expanded` adds the last
 * messages under it (still above the composer).
 */
export function FullscreenChatDockHeader({
  status,
  latestStep,
  expanded,
  messages,
  onToggleExpanded,
  onMinimize,
  detached = false,
}: {
  status: ChatDockStatus;
  latestStep: string;
  expanded: boolean;
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text">>;
  onToggleExpanded: () => void;
  onMinimize: () => void;
  /** The composer has its own frame (an approval / a question is open): a slim row of its own. */
  detached?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, messages]);

  const step = chatDockStepPreview(latestStep) || "No messages yet";
  const toggleLabel = expanded ? "Hide recent messages" : "Show recent messages";
  return (
    <div
      data-chat-dock-header="true"
      data-chat-dock-expanded={expanded ? "true" : "false"}
      className={cn(
        detached &&
          "mx-auto mb-1.5 w-full max-w-208 overflow-hidden rounded-xl border border-border/70 bg-card/95 shadow-lg shadow-black/8 backdrop-blur-xl",
      )}
    >
      <div className="flex h-7 items-center gap-1.5 pt-0.5 pl-3.5 pr-1 text-muted-foreground text-xs">
        <ChatDockStatusDot status={status} />
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-foreground"
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={CHAT_DOCK_STATUS_LABEL[status]}
        >
          <span className="shrink-0 font-medium text-muted-foreground/80">
            {status === "working" ? "Working" : status === "your-turn" ? "Latest" : "Needs you"}
          </span>
          <span className="min-w-0 truncate text-foreground/70">{step}</span>
        </button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onToggleExpanded}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={onMinimize}
          title="Hide the chat while you look at the tab — it stays in the corner"
          className="text-muted-foreground"
          data-chat-dock-minimize="true"
        >
          <PanelBottomCloseIcon />
          Hide chat
        </Button>
      </div>
      {expanded ? (
        <div
          ref={scrollRef}
          className="max-h-[min(16rem,32vh)] overflow-y-auto border-border/50 border-t px-3.5 py-2"
        >
          <ChatDockMessages messages={messages} />
        </div>
      ) : null}
    </div>
  );
}
