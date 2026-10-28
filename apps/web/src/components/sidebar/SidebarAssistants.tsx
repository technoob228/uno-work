/**
 * Top of the sidebar: the person's assistants (Misha 16.10, w0138 p6–p7) —
 * Uno and the teammates set up next to it, one row each with its face and a
 * dot: working (blue), waiting for you (amber), free (green).
 *
 * - A click on the row opens its latest chat (a new one if there is none; the
 *   setup if it was never set up).
 * - The chevron unfolds its chats, newest first: 3, then "Show N more".
 *   Before this, a second chat with Uno could only be found in Settings.
 * - The pencil on hover starts a new chat with it; its face opens its page.
 * - "+" next to the "Assistants" header (Misha 23.10) is always there with
 *   the team: one click makes an assistant and opens its page
 *   (`useQuickCreateAssistant.tsx`) — no dialog.
 *
 * Without the assistants update on the account (`useTeamShown`) it is Uno
 * alone: no "New assistant", the face opens Uno's page under Assistants, the
 * first click introduces Uno. With it (22.10) — the team, as the daemon keeps
 * it. Without the team the block is behind Labs "Uno's chats in the sidebar"
 * (Sidebar.tsx).
 */
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LoaderCircleIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, memo, useState } from "react";
import { create } from "zustand";

import { useAssistantChat } from "../../assistant/useAssistantChat";
import { createAssistantConversation } from "../../lib/managerApi";
import { toastManager } from "../ui/toast";
import {
  CHANNELS_PREVIEW,
  channelName,
  cleanChannelName,
  orderChannels,
  useUnoHome,
  waitForThread,
} from "../assistants/useUnoHome";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { AssistantAvatar, avatarImageOf } from "../assistants/AssistantAvatar";
import {
  AssistantOnboardingDialog,
  useAssistantOnboarding,
} from "../assistants/AssistantOnboarding";
import {
  ACTIVITY_LABEL,
  latestConversation,
  previewChats,
} from "../assistants/assistantTeam.logic";
import { type TeamMember, useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";
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
  // Uno's main chat (the one Telegram and Slack talk to) is made by the daemon.
  const assistantChat = useAssistantChat();
  const openSetup = useAssistantOnboarding((state) => state.openFor);
  const teamShown = useTeamShown();
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
      // The very first chat with Uno is its main one, as before 0.0.139.
      if (member.isUno && assistantChat.environmentId === member.environmentId) {
        leave();
        void assistantChat.open();
        return;
      }
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
    // Without the team: Uno's page under Assistants.
    void navigate(
      teamShown
        ? {
            to: "/assistants",
            search: { view: "profile", env: member.environmentId, project: member.projectId },
          }
        : { to: "/assistants" },
    );
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
              image={avatarImageOf(member.profile)}
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
          <span className="min-w-0 truncate text-sm font-medium text-foreground" title={name}>
            {name}
          </span>
          {/* Variant A: an own assistant says its role (they live in Advanced). */}
          {!member.isUno && member.profile.roles[0] && member.configured ? (
            <span className="ml-auto shrink-0 truncate pr-1 text-[11px] text-muted-foreground">
              {member.profile.roles[0]}
            </span>
          ) : null}
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

/**
 * Before this computer has Uno's folder (a fresh computer, an older daemon):
 * one row that opens Uno's chat the way 0.0.137 did — the daemon makes it.
 */
function UnoFallbackRow() {
  const { environmentId, opening, open } = useAssistantChat();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <li className="list-none" data-testid="sidebar-assistant" data-assistant="uno-fallback">
      <button
        type="button"
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          sidebarDPanel.closeNow();
          void open();
        }}
        disabled={environmentId === null || opening}
        data-testid="sidebar-uno"
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className="ml-1 inline-flex size-6 shrink-0 items-center justify-center">
          <AssistantAvatar emoji={null} tone="violet" activity={null} />
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">Uno</span>
      </button>
    </li>
  );
}

/**
 * Variant A (28.10): one Uno for the account. Its row says where it lives
 * ("uno-work · always on"); under it its channels — Everything first, then
 * the topics you made — and "New channel". Your own assistants (made in
 * Advanced) follow, each with its role. No "+" here: Uno is the one you
 * talk to; extras live behind Uno's page → Advanced.
 */
const UnoChannels = memo(function UnoChannels(props: {
  readonly uno: TeamMember;
  /** What it runs right now on any computer (shown under it while it runs). */
  readonly running: ReadonlyArray<SidebarThreadSummary>;
  readonly routeThreadKey: string | null;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const { uno } = props;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [showAll, setShowAll] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const channels = orderChannels(uno.chats.conversations);
  const isOpen = (thread: SidebarThreadSummary) => threadKeyOf(thread) === props.routeThreadKey;
  const preview = previewChats(channels, { showAll, isOpen, limit: CHANNELS_PREVIEW });

  const create = async () => {
    const name = cleanChannelName(draft);
    if (name === null || creating) return;
    setCreating(true);
    try {
      const { threadId } = await createAssistantConversation({
        environmentId: uno.environmentId as EnvironmentId,
        title: name,
      });
      setNaming(false);
      setDraft("");
      await waitForThread(uno.environmentId, threadId);
      if (isMobile) setOpenMobile(false);
      sidebarDPanel.closeNow();
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: uno.environmentId as EnvironmentId,
          threadId,
        }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't make the channel",
        description: cause instanceof Error ? cause.message : "Uno's computer didn't answer.",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <ul role="list" className="flex flex-col gap-px" data-testid="sidebar-uno-channels">
      {preview.visible.map((thread) =>
        props.renderChat({
          ...thread,
          title: thread.assistantRole === "chat" ? "Everything" : `# ${channelName(thread)}`,
        }),
      )}
      {props.running.map((thread) => props.renderChat(thread))}
      {preview.hiddenCount > 0 || showAll ? (
        <li className="list-none">
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            data-testid="sidebar-uno-channels-more"
            className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-8 text-left text-xs text-sidebar-muted-foreground/70 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {preview.hiddenCount > 0 ? `Show ${preview.hiddenCount} more` : "Show less"}
          </button>
        </li>
      ) : null}
      <li className="list-none">
        {naming ? (
          <form
            className="flex h-7 items-center gap-1 pr-1 pl-7"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <span className="text-xs text-muted-foreground">#</span>
            <input
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={draft}
              maxLength={40}
              disabled={creating}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setNaming(false);
                  setDraft("");
                }
              }}
              onBlur={() => {
                if (draft.trim() === "" && !creating) setNaming(false);
              }}
              placeholder="channel name"
              aria-label="New channel name"
              data-testid="sidebar-uno-new-channel-input"
              className="h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
            {creating ? (
              <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            data-testid="sidebar-uno-new-channel"
            className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-7 text-left text-xs text-sidebar-muted-foreground/80 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PlusIcon className="size-3.5" />
            New channel
          </button>
        )}
      </li>
    </ul>
  );
});

function UnoHomeRow(props: { readonly uno: TeamMember; readonly routeThreadKey: string | null }) {
  const { uno } = props;
  const navigate = useNavigate();
  const home = useUnoHome();
  const { isMobile, setOpenMobile } = useSidebar();
  const leave = () => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
  };
  const main = uno.chats.conversations.find((thread) => thread.assistantRole === "chat") ?? null;
  const assistantChat = useAssistantChat();
  const open = () => {
    leave();
    if (main === null) {
      void assistantChat.open();
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: main.environmentId,
        threadId: main.id as ThreadId,
      }),
    });
  };
  const openPage = () => {
    leave();
    void navigate({
      to: "/assistants",
      search: { view: "profile", env: uno.environmentId, project: uno.projectId },
    });
  };
  const asleep = home.alwaysOn === false;
  return (
    <div
      className="group/assistant flex h-7 w-full items-center rounded-md hover:bg-sidebar-row-hover"
      data-testid="sidebar-assistant"
      data-assistant={uno.projectId}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={openPage}
              aria-label={`${uno.profile.name}'s page`}
              data-testid="sidebar-assistant-face"
              className="ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <AssistantAvatar emoji={null} tone="violet" activity={uno.activity} />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {uno.profile.name} · {ACTIVITY_LABEL[uno.activity]} — open its page
        </TooltipPopup>
      </Tooltip>
      <button
        type="button"
        onClick={open}
        data-testid="sidebar-assistant-open"
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={uno.profile.name}
        >
          {uno.profile.name}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 pr-2 text-[11px]",
            asleep ? "text-warning" : "text-muted-foreground",
          )}
          data-testid="sidebar-uno-home"
          title={home.line}
        >
          {asleep ? "sleeps on Free" : home.label}
        </span>
      </button>
    </div>
  );
}

export const SidebarAssistants = memo(function SidebarAssistants(props: {
  readonly routeThreadKey: string | null;
  /** Uno's work chats that are still running (the sidebar keeps them under Uno). */
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const team = useAssistantTeam();
  const unfolded = useUnfoldedStore((state) => state.keys);
  const setUnfolded = useUnfoldedStore((state) => state.set);
  const live = team.filter((member) => !member.revoked);
  const uno = live.find((member) => member.isUno) ?? null;
  const own = live.filter((member) => !member.isUno);
  const [showAllOwn, setShowAllOwn] = useState(false);
  const ownShown = showAllOwn ? own : own.slice(0, CHANNELS_PREVIEW);

  return (
    <li className="list-none pb-1" data-testid="sidebar-assistants">
      <div
        className="flex h-6 items-center justify-between pr-1 pl-2.5"
        data-testid="sidebar-assistants-header"
      >
        <span className="text-xs font-medium text-sidebar-muted-foreground/70">Uno</span>
      </div>
      <ul role="list" className="flex flex-col gap-px">
        {uno ? (
          <li className="list-none">
            <UnoHomeRow uno={uno} routeThreadKey={props.routeThreadKey} />
            <UnoChannels
              uno={uno}
              running={props.unoRunning}
              routeThreadKey={props.routeThreadKey}
              renderChat={props.renderChat}
            />
          </li>
        ) : (
          <UnoFallbackRow />
        )}
        {ownShown.map((member) => (
          <AssistantRow
            key={member.key}
            member={member}
            unfolded={unfolded.has(member.key)}
            onToggle={() => setUnfolded(member.key, !unfolded.has(member.key))}
            routeThreadKey={props.routeThreadKey}
            extraChats={[]}
            renderChat={props.renderChat}
          />
        ))}
        {own.length > CHANNELS_PREVIEW ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setShowAllOwn((value) => !value)}
              data-testid="sidebar-own-assistants-more"
              className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-8 text-left text-xs text-sidebar-muted-foreground/70 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAllOwn ? "Show less" : `${own.length - CHANNELS_PREVIEW} more assistants`}
            </button>
          </li>
        ) : null}
      </ul>
      <AssistantOnboardingDialog />
    </li>
  );
});
