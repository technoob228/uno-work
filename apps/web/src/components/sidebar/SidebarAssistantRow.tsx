/**
 * "Uno" — the assistant, one row on top of the sidebar. A click opens its
 * main conversation (or sets it up: see `useAssistantChat`); the chevron
 * unfolds its conversations (0.0.85): the main one — the one Telegram and
 * Slack talk to — and the others started with "New conversation". They all
 * share Uno's memory. The row can be hidden in Settings → Assistant; Uno
 * stays on Home and in ⌘K.
 */
import { ChevronRightIcon, PlusIcon, SendIcon } from "lucide-react";
import { memo, useState } from "react";
import { useParams } from "@tanstack/react-router";

import { useAssistantChannels } from "../../assistant/useAssistantChannels";
import { useAssistantChat } from "../../assistant/useAssistantChat";
import { useAssistantConversations } from "../../assistant/useAssistantConversations";
import {
  useAssistantConversationsExpanded,
  useShowAssistantInSidebar,
} from "../../assistant/assistantPrefs";
import {
  ASSISTANT_CHAT_NAME,
  ASSISTANT_CONVERSATIONS_PREVIEW,
  assistantConversationLabel,
} from "../../assistant/assistantChat.logic";
import { cn } from "../../lib/utils";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";

const STATUS: Record<
  ReturnType<typeof resolveSidebarThreadStatus>,
  { label: string; dot: string } | null
> = {
  approval: { label: "needs approval", dot: "bg-amber-500" },
  input: { label: "asks you", dot: "bg-indigo-500" },
  working: { label: "working", dot: "animate-pulse bg-sky-500" },
  failed: { label: "failed", dot: "bg-red-500" },
  ready: null,
};

export const SidebarAssistantRow = memo(function SidebarAssistantRow() {
  const [showInSidebar] = useShowAssistantInSidebar();
  if (!showInSidebar) return null;
  return <SidebarAssistantRowVisible />;
});

function SidebarAssistantRowVisible() {
  const { environmentId, chat, opening, open } = useAssistantChat();
  const conversations = useAssistantConversations();
  const channels = useAssistantChannels(environmentId);
  const { isMobile, setOpenMobile } = useSidebar();
  const [expandedPref, setExpanded] = useAssistantConversationsExpanded();
  const [showAll, setShowAll] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.threadId ?? null,
  });
  const others = conversations.conversations.filter((thread) => thread.id !== chat?.id);
  const onOtherConversation = others.some((thread) => thread.id === routeThreadId);
  // Folded out while one of its conversations is open, so the open one is visible.
  const expanded = expandedPref || onOtherConversation;
  const active = chat !== null && routeThreadId === chat.id;
  const status = chat ? STATUS[resolveSidebarThreadStatus(chat)] : null;
  const busyElsewhere = others.some(
    (thread) => STATUS[resolveSidebarThreadStatus(thread)] !== null,
  );
  const subtitle =
    status?.label ??
    (others.length > 0
      ? `${others.length + 1} conversations · always on`
      : "Your assistant · always on");
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const listed =
    showAll || others.length <= ASSISTANT_CONVERSATIONS_PREVIEW + 1
      ? others
      : others.slice(0, ASSISTANT_CONVERSATIONS_PREVIEW);

  return (
    <div data-testid="sidebar-uno-group">
      <div
        className={cn(
          "group/uno flex w-full items-center rounded-lg transition-colors",
          active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          onClick={() => {
            closeMobile();
            void open();
          }}
          disabled={environmentId === null || opening}
          aria-current={active ? "page" : undefined}
          data-testid="sidebar-uno"
          title="Uno: main conversation"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-foreground outline-hidden ring-ring focus-visible:ring-2 disabled:cursor-default"
        >
          <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-primary-foreground">
            U
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar",
                status ? status.dot : busyElsewhere ? "bg-sky-500" : "bg-success",
              )}
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{ASSISTANT_CHAT_NAME}</span>
            <span
              className={cn(
                "truncate text-[11px]",
                status ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              {subtitle}
            </span>
          </span>
          {channels.telegram === "on" ? (
            <span
              title="Also answers in Telegram"
              className="grid size-5 shrink-0 place-items-center rounded-full bg-sky-500 text-white"
            >
              <SendIcon className="size-2.5" />
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? "Hide Uno's conversations" : "Show Uno's conversations"}
          title={expanded ? "Hide conversations" : "Conversations"}
          data-testid="sidebar-uno-expand"
          className="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
      </div>
      {expanded ? (
        <ul className="mt-0.5 mb-1 ml-5 flex flex-col border-l border-border/60 pl-2">
          {chat ? (
            <ConversationItem
              label={assistantConversationLabel(chat)}
              active={active}
              dot={status?.dot ?? null}
              telegram={channels.telegram === "on"}
              testId="sidebar-uno-conversation-main"
              onClick={() => {
                closeMobile();
                void open();
              }}
            />
          ) : null}
          {listed.map((thread) => {
            const threadStatus = STATUS[resolveSidebarThreadStatus(thread)];
            return (
              <ConversationItem
                key={thread.id}
                label={assistantConversationLabel(thread)}
                active={routeThreadId === thread.id}
                dot={threadStatus?.dot ?? null}
                telegram={false}
                testId="sidebar-uno-conversation"
                onClick={() => {
                  closeMobile();
                  void conversations.openConversation(thread.id);
                }}
              />
            );
          })}
          {listed.length < others.length ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full cursor-pointer rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
              >
                Show all ({others.length + 1})
              </button>
            </li>
          ) : null}
          {conversations.supported ? (
            <li>
              <button
                type="button"
                onClick={() => {
                  closeMobile();
                  void conversations.createConversation();
                }}
                disabled={conversations.creating}
                data-testid="sidebar-uno-new-conversation"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground disabled:cursor-default disabled:opacity-60"
              >
                <PlusIcon className="size-3" />
                New conversation
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function ConversationItem(props: {
  readonly label: string;
  readonly active: boolean;
  readonly dot: string | null;
  readonly telegram: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
        data-testid={props.testId}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] outline-hidden ring-ring focus-visible:ring-2",
          props.active
            ? "bg-sidebar-row-active text-foreground"
            : "text-foreground/85 hover:bg-sidebar-row-hover",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.telegram ? (
          <span title="Telegram and Slack talk to this conversation">
            <SendIcon className="size-3 text-sky-500" />
          </span>
        ) : null}
        {props.dot ? (
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.dot)} />
        ) : null}
      </button>
    </li>
  );
}
