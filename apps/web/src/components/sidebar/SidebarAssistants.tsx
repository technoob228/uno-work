/**
 * Top of the sidebar: the person's assistants (Misha 16.10, w0138 p6–p7) —
 * Uno and the teammates set up next to it, one row each with its face and a
 * dot: working (blue), waiting for you (amber), free (green).
 *
 * - A click on the row opens its latest chat (a new one if there is none; the
 *   setup if it was never set up).
 * - The chevron unfolds its chats, newest first: 3, then "Show N more".
 *   Before this, a second chat with Uno could only be found in Settings.
 * - "+" on hover starts a new chat with it; its face opens its page.
 * - "New assistant" at the end starts the setup (`AssistantOnboarding.tsx`)
 *   while Uno is alone; with a team it moves to the Team block of the pages.
 */
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, memo, useState } from "react";
import { create } from "zustand";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { AssistantAvatar } from "../assistants/AssistantAvatar";
import {
  AssistantOnboardingDialog,
  useAssistantOnboarding,
} from "../assistants/AssistantOnboarding";
import {
  ACTIVITY_LABEL,
  latestConversation,
  previewChats,
} from "../assistants/assistantTeam.logic";
import { type TeamMember, useAssistantTeam } from "../assistants/useAssistantTeam";
import { useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sidebarDPanel } from "./sidebarDState";

const OPEN_KEY = "sidebar:assistants-open:v1";

function readOpen(): ReadonlyArray<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

const threadKeyOf = (thread: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Unfolded assistants, kept across reloads. */
const useUnfoldedStore = create<{
  readonly keys: ReadonlySet<string>;
  readonly set: (key: string, open: boolean) => void;
}>((set, get) => ({
  keys: new Set(typeof localStorage === "undefined" ? [] : readOpen()),
  set: (key, open) => {
    const keys = new Set(get().keys);
    if (open) keys.add(key);
    else keys.delete(key);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...keys]));
    } catch {
      // fine: unfolded for this session
    }
    set({ keys });
  },
}));

/** Unfolds an assistant's chats from outside the sidebar (its page, the demo). */
export function unfoldAssistantInSidebar(key: string) {
  useUnfoldedStore.getState().set(key, true);
}

function HoverButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly visible?: boolean;
  readonly testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            onClick={props.onClick}
            data-testid={props.testId}
            className={cn(
              "text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100",
              props.visible ? "opacity-100" : "opacity-0 group-hover/assistant:opacity-100",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const AssistantRow = memo(function AssistantRow(props: {
  readonly member: TeamMember;
  readonly unfolded: boolean;
  readonly onToggle: () => void;
  readonly routeThreadKey: string | null;
  readonly extraChats: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const { member } = props;
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const openSetup = useAssistantOnboarding((state) => state.openFor);
  const { isMobile, setOpenMobile } = useSidebar();
  const [showAll, setShowAll] = useState(false);

  const chats = [...props.extraChats, ...member.chats.conversations];
  const isOpen = (thread: SidebarThreadSummary) => threadKeyOf(thread) === props.routeThreadKey;
  const holdsOpenChat = chats.some(isOpen);
  // A folded assistant with the open chat in it stays unfolded, so the chat is seen.
  const unfolded = (props.unfolded || holdsOpenChat) && chats.length > 0;
  const preview = previewChats(chats, { showAll, isOpen });
  const latest = latestConversation(member.chats);
  const rowActive = !unfolded && latest !== null && isOpen(latest);

  const leave = () => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
  };
  const newChat = () => {
    leave();
    void handleNewThread(
      scopeProjectRef(member.environmentId as EnvironmentId, member.projectId as ProjectId),
      { envMode: "local" },
    );
  };
  const openRow = () => {
    if (!member.configured) {
      openSetup(member);
      return;
    }
    if (latest === null) {
      newChat();
      return;
    }
    leave();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: member.environmentId as EnvironmentId,
        threadId: latest.id as ThreadId,
      }),
    });
  };
  const openPage = () => {
    leave();
    void navigate({
      to: "/assistants",
      search: { view: "profile", env: member.environmentId, project: member.projectId },
    });
  };
  const name = member.profile.name;
  const status = ACTIVITY_LABEL[member.activity];

  return (
    <li
      className="group/assistant list-none"
      data-testid="sidebar-assistant"
      data-assistant={member.projectId}
    >
      <div
        className={cn(
          "flex h-7 w-full items-center rounded-md transition-colors",
          rowActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={openPage}
                aria-label={`${name}'s page`}
                data-testid="sidebar-assistant-face"
                className="ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <AssistantAvatar
              emoji={member.profile.emoji}
              tone={member.profile.tone}
              activity={member.configured ? member.activity : null}
            />
          </TooltipTrigger>
          <TooltipPopup side="right">
            {name} · {member.configured ? status : "Not set up yet"} — open its page
          </TooltipPopup>
        </Tooltip>
        <button
          type="button"
          onClick={openRow}
          aria-current={rowActive ? "page" : undefined}
          data-testid="sidebar-assistant-open"
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
          {/* One signal for "waits for you": the dot (the Inbox counts it too). */}
          {!member.configured ? (
            <span className="shrink-0 text-xs text-primary">Set up</span>
          ) : null}
        </button>
        {chats.length > 0 ? (
          <HoverButton
            label={unfolded ? `Hide ${name}'s chats` : `${name}'s chats (${chats.length})`}
            onClick={props.onToggle}
            visible={unfolded}
            testId="sidebar-assistant-toggle"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", unfolded && "rotate-90")}
            />
          </HoverButton>
        ) : null}
        {member.configured ? (
          <span className="mr-1">
            <HoverButton
              label={`New chat with ${name}`}
              onClick={newChat}
              testId="sidebar-assistant-new-chat"
            >
              <SquarePenIcon className="size-3.5" />
            </HoverButton>
          </span>
        ) : null}
      </div>
      {unfolded ? (
        <ul role="list" className="flex flex-col gap-px" data-testid="sidebar-assistant-chats">
          {preview.visible.map((thread) =>
            // The main chat (Telegram / Slack talk to it) is named after the
            // assistant: under its own row it reads as "Main chat".
            props.renderChat(
              thread.assistantRole === "chat" && thread.title === name
                ? { ...thread, title: "Main chat" }
                : thread,
            ),
          )}
          {preview.hiddenCount > 0 || showAll ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-8 text-left text-xs text-sidebar-muted-foreground/55 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {preview.hiddenCount > 0 ? `Show ${preview.hiddenCount} more` : "Show less"}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});

export const SidebarAssistants = memo(function SidebarAssistants(props: {
  readonly routeThreadKey: string | null;
  /** Uno's work chats that are still running (the sidebar keeps them under Uno). */
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const team = useAssistantTeam();
  const unfolded = useUnfoldedStore((state) => state.keys);
  const setUnfolded = useUnfoldedStore((state) => state.set);
  const openNew = useAssistantOnboarding((state) => state.openNew);
  const live = team.filter((member) => !member.revoked);

  return (
    <li className="list-none pb-1" data-testid="sidebar-assistants">
      <ul role="list" className="flex flex-col gap-px">
        {live.map((member) => (
          <AssistantRow
            key={member.key}
            member={member}
            unfolded={unfolded.has(member.key)}
            onToggle={() => setUnfolded(member.key, !unfolded.has(member.key))}
            routeThreadKey={props.routeThreadKey}
            extraChats={member.isUno ? props.unoRunning : []}
            renderChat={props.renderChat}
          />
        ))}
        {/* Critics 16.10: the top of the sidebar is short. "New assistant" has
            its own row only before there is a team; with one, it is in the
            Team block of every assistant's page. */}
        {live.length > 1 ? null : (
          <li className="list-none">
            <button
              type="button"
              onClick={() => openNew()}
              data-testid="sidebar-new-assistant"
              className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left text-xs text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="ml-1 inline-flex size-6 shrink-0 items-center justify-center">
                <span className="grid size-5 place-items-center rounded-full border border-dashed border-muted-foreground/40">
                  <PlusIcon className="size-3" />
                </span>
              </span>
              New assistant
            </button>
          </li>
        )}
      </ul>
      <AssistantOnboardingDialog />
    </li>
  );
});
