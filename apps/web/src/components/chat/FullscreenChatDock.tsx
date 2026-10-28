/**
 * The chat under a panel tab opened on the whole window (w0138 p3): the latest
 * step is the top edge of the composer's own block — one dense block, not two
 * floating pills. The chevron shows the last messages right above the
 * composer; the fold button sends the chat to a mini window (ChatMiniWindow).
 */
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MessageSquareTextIcon,
  PanelBottomCloseIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
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

/**
 * Messages of the chat, dense: the person's on the right as typed, the
 * agent's rendered like in the chat (P13, 28.10: `**Notetaker**` showed raw),
 * smaller and cut after six lines.
 */
export function ChatDockMessages({
  messages,
  className,
  markdownCwd,
}: {
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text">>;
  className?: string;
  /** The chat's folder: file links in the agent's words open from it. */
  markdownCwd?: string | undefined;
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
            data-chat-dock-reply="true"
            className="line-clamp-6 break-words text-[13px] leading-5 text-foreground/90 [&_.chat-markdown]:text-[13px] [&_.chat-markdown]:leading-5 [&_.chat-markdown]:text-foreground/90 [&_.chat-markdown_ol]:my-1 [&_.chat-markdown_p]:my-1 [&_.chat-markdown_ul]:my-1"
          >
            <ChatMarkdown text={message.text.trim() || "…"} cwd={markdownCwd} />
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
  markdownCwd,
}: {
  status: ChatDockStatus;
  latestStep: string;
  expanded: boolean;
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text">>;
  markdownCwd?: string | undefined;
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
          <ChatDockMessages messages={messages} markdownCwd={markdownCwd} />
        </div>
      ) : null}
    </div>
  );
}

const LEGACY_FOCUS_CHAT_PREVIEW_BOTTOM = "5.75rem";

function formatLegacyFocusPreviewMessageText(message: ChatMessage | undefined): string {
  const text = message?.text.trim() ?? "";
  if (!text) return "No messages yet";
  return text.replace(/\s+/g, " ").slice(0, 240);
}

/**
 * The chat over a full-screen panel tab as in 0.0.137 (flag `fullscreenChatDock`
 * off): a "Latest step" pill floating above the composer, which opens the
 * "Latest conversation" card with the last two messages.
 */
export function LegacyFocusChatPreview({
  mode,
  onModeChange,
  messages,
  sidebarVisible,
}: {
  mode: "peek" | "expanded";
  onModeChange: (mode: "peek" | "expanded") => void;
  messages: ReadonlyArray<ChatMessage>;
  sidebarVisible: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const latestMessage = messages[messages.length - 1];

  useEffect(() => {
    if (mode !== "expanded") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const scrollElement = scrollRef.current;
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [mode, messages]);

  return (
    <div
      className="pointer-events-none fixed right-0 z-[69] px-4 sm:px-6"
      style={{
        left: sidebarVisible ? "var(--sidebar-width)" : "0px",
        bottom: LEGACY_FOCUS_CHAT_PREVIEW_BOTTOM,
      }}
      data-focus-chat-preview="true"
    >
      <div className="pointer-events-auto mx-auto w-full max-w-[76rem]">
        {mode === "expanded" ? (
          <div
            className="max-h-[min(18rem,32vh)] overflow-hidden rounded-2xl border border-border/70 bg-card/92 shadow-2xl shadow-black/12 backdrop-blur-xl"
            data-focus-chat-preview-panel="expanded"
          >
            <div className="flex h-10 items-center gap-2 border-b border-border/60 px-4">
              <MessageSquareTextIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                Latest conversation
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                onClick={() => onModeChange("peek")}
                aria-label="Collapse chat preview"
              >
                <ChevronDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                onClick={() => onModeChange("peek")}
                aria-label="Hide expanded chat preview"
              >
                <XIcon />
              </Button>
            </div>
            <div
              ref={scrollRef}
              className="max-h-[calc(min(18rem,32vh)-2.5rem)] overflow-y-auto px-4 py-3"
            >
              {messages.length > 0 ? (
                <div className="flex min-h-full flex-col justify-end gap-3">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn(
                        "max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-5",
                        message.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      <div className="mb-1 text-[11px] font-medium opacity-65">
                        {message.role === "user" ? "You" : "Assistant"}
                      </div>
                      {message.role === "user" ? (
                        <div className="whitespace-pre-wrap break-words">
                          {message.text.trim() || "(empty)"}
                        </div>
                      ) : (
                        <ChatMarkdown text={message.text.trim() || "(empty)"} cwd={undefined} />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  No messages yet
                </div>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onModeChange("expanded")}
            className="flex h-9 w-full items-center gap-2 rounded-full border border-border/65 bg-card/86 px-3.5 text-left text-sm shadow-xl shadow-black/8 backdrop-blur-xl hover:bg-card"
            aria-label="Expand chat preview"
            data-focus-chat-preview-panel="peek"
          >
            <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-muted-foreground text-xs">Latest step</span>
            <span className="min-w-0 flex-1 truncate text-foreground/80">
              {formatLegacyFocusPreviewMessageText(latestMessage)}
            </span>
            <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  );
}
