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
import { useQuickCreateAssistant } from "../assistants/useQuickCreateAssistant";
import { type TeamMember, useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";
import { useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VARIANT_C } from "../../demo/demoFlag";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { threadActivityMs } from "../assistants/useAssistantTeam";
import { type UnoHand, handAwake, handLine, useUnoHands } from "../assistants/variantC/useUnoHands";
import { useUnoPlan } from "../assistants/variantC/useUnoPlan";
import { useShallow } from "zustand/react/shallow";
import { assistantsHeaderState } from "./sidebarAssistants.logic";
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
  /** Variant C: a short line after the name (Uno: where it lives; a teammate: its role). */
  readonly meta?: string | null;
  /** Variant C: a teammate sits under Uno (indented). */
  readonly nested?: boolean;
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
      className={cn("group/assistant list-none", props.nested && "pl-3")}
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
          {props.meta ? (
            <span
              className="ml-auto min-w-0 shrink truncate pr-1 text-[11px] text-sidebar-muted-foreground/70"
              data-testid="sidebar-assistant-meta"
            >
              {props.meta}
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

export const SidebarAssistants = memo(function SidebarAssistants(props: {
  readonly routeThreadKey: string | null;
  /** Uno's work chats that are still running (the sidebar keeps them under Uno). */
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  if (VARIANT_C) return <SidebarUnoC {...props} />;
  return <SidebarAssistantsTeam {...props} />;
});

const SidebarAssistantsTeam = memo(function SidebarAssistantsTeam(props: {
  readonly routeThreadKey: string | null;
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const team = useAssistantTeam();
  const teamShown = useTeamShown();
  const unfolded = useUnfoldedStore((state) => state.keys);
  const setUnfolded = useUnfoldedStore((state) => state.set);
  const quick = useQuickCreateAssistant();
  const live = team.filter((member) => !member.revoked);
  const header = assistantsHeaderState({ teamShown });

  return (
    <li className="list-none pb-1" data-testid="sidebar-assistants">
      {header.showHeader ? (
        <div
          className="flex h-6 items-center justify-between pr-1 pl-2.5"
          data-testid="sidebar-assistants-header"
        >
          <span className="text-xs font-medium text-sidebar-muted-foreground/70">Assistants</span>
          {header.showCreate ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="New assistant"
                    disabled={quick.creating || !quick.available}
                    onClick={() => void quick.create()}
                    data-testid="sidebar-new-assistant"
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                {quick.creating ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="right">New assistant</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
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
        {live.length === 0 ? <UnoFallbackRow /> : null}
      </ul>
      <AssistantOnboardingDialog />
    </li>
  );
});

// ── Variant C (28.10): one Uno, its computers, your team under it ─────────

/** Teammates shown before "Show N more" (the 10+ edge). */
const TEAM_PREVIEW = 4;

function CaptionRow(props: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <li className="flex h-6 list-none items-center justify-between pr-1 pl-6">
      <span className="text-[11px] text-sidebar-muted-foreground/60">{props.children}</span>
      {props.action}
    </li>
  );
}

/** "Uno on <computer>": a row per computer — awake or not, what runs there; unfolds its chats. */
function HandRow(props: {
  readonly hand: UnoHand;
  readonly unfolded: boolean;
  readonly onToggle: () => void;
  readonly chats: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const { hand } = props;
  const Icon = MACHINE_KIND_ICON[hand.kind];
  const awake = handAwake(hand);
  const busy = hand.running.length > 0 || hand.waiting.length > 0;
  return (
    <li className="list-none" data-testid="sidebar-uno-hand" data-machine={hand.label}>
      <button
        type="button"
        onClick={props.onToggle}
        disabled={props.chats.length === 0}
        aria-expanded={props.unfolded}
        title={`Uno on ${hand.label}`}
        className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-6 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            awake ? "text-sidebar-foreground/70" : "text-sidebar-muted-foreground/40",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            awake ? "text-sidebar-foreground" : "text-sidebar-muted-foreground/60",
          )}
        >
          {hand.label}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[11px]",
            hand.waiting.length > 0
              ? "text-warning"
              : busy
                ? "text-sky-600 dark:text-sky-400"
                : "text-sidebar-muted-foreground/60",
          )}
          data-testid="sidebar-uno-hand-state"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              !awake
                ? "bg-muted-foreground/30"
                : hand.waiting.length > 0
                  ? "bg-warning"
                  : busy
                    ? "bg-sky-500"
                    : "bg-success",
            )}
          />
          {handLine(hand)}
        </span>
      </button>
      {props.unfolded && props.chats.length > 0 ? (
        <ul role="list" className="flex flex-col gap-px pl-4">
          {props.chats.slice(0, 3).map((thread) => props.renderChat(thread))}
        </ul>
      ) : null}
    </li>
  );
}

const SidebarUnoC = memo(function SidebarUnoC(props: {
  readonly routeThreadKey: string | null;
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const team = useAssistantTeam();
  const hands = useUnoHands();
  const navigate = useNavigate();
  const unfolded = useUnfoldedStore((state) => state.keys);
  const setUnfolded = useUnfoldedStore((state) => state.set);
  const [showAll, setShowAll] = useState(false);
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const live = team.filter((member) => !member.revoked);
  const uno = live.find((member) => member.isUno) ?? null;
  const mates = live.filter((member) => !member.isUno);
  const shownMates = showAll ? mates : mates.slice(0, TEAM_PREVIEW);
  const free = useUnoPlan() === "free";
  const newTeammate = () => void navigate({ to: "/assistants", search: { view: "new" } });
  const unoHome = hands.find((hand) => hand.environmentId === uno?.environmentId);
  const chatsOn = (environmentId: string | null) =>
    threads
      .filter(
        (thread) =>
          environmentId !== null &&
          thread.environmentId === environmentId &&
          !String(thread.projectId).startsWith("assistant-") &&
          thread.archivedAt === null,
      )
      .toSorted((a, b) => threadActivityMs(b) - threadActivityMs(a));

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
          <AssistantRow
            key={uno.key}
            member={uno}
            unfolded={unfolded.has(uno.key)}
            onToggle={() => setUnfolded(uno.key, !unfolded.has(uno.key))}
            routeThreadKey={props.routeThreadKey}
            extraChats={props.unoRunning}
            renderChat={props.renderChat}
            meta={free ? "sleeps on Free" : unoHome ? `on ${unoHome.label}` : null}
          />
        ) : (
          <UnoFallbackRow />
        )}
        {hands.length > 1 ? (
          <>
            <CaptionRow>Works on your computers</CaptionRow>
            {hands.map((hand) => {
              const key = `hand:${hand.key}`;
              return (
                <HandRow
                  key={hand.key}
                  hand={hand}
                  unfolded={unfolded.has(key)}
                  onToggle={() => setUnfolded(key, !unfolded.has(key))}
                  chats={chatsOn(hand.environmentId)}
                  renderChat={props.renderChat}
                />
              );
            })}
          </>
        ) : null}
        <CaptionRow
          action={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="New teammate"
                    onClick={newTeammate}
                    data-testid="sidebar-new-assistant"
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">New teammate — works under Uno</TooltipPopup>
            </Tooltip>
          }
        >
          {mates.length > 0 ? `Team · ${mates.length}` : "Team"}
        </CaptionRow>
        {shownMates.map((member) => (
          <AssistantRow
            key={member.key}
            member={member}
            unfolded={unfolded.has(member.key)}
            onToggle={() => setUnfolded(member.key, !unfolded.has(member.key))}
            routeThreadKey={props.routeThreadKey}
            // A task Uno handed it shows under it while it runs or waits.
            extraChats={member.chats.work.filter(
              (thread) => resolveSidebarThreadStatus(thread) !== "ready",
            )}
            renderChat={props.renderChat}
            meta={member.profile.roles[0] ?? null}
            nested
          />
        ))}
        {mates.length > TEAM_PREVIEW ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              data-testid="sidebar-team-more"
              className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-6 text-left text-xs text-sidebar-muted-foreground/55 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAll ? "Show less" : `Show ${mates.length - TEAM_PREVIEW} more`}
            </button>
          </li>
        ) : null}
        {mates.length === 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={newTeammate}
              data-testid="sidebar-add-teammate"
              className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-6 text-left text-xs text-sidebar-muted-foreground/70 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PlusIcon className="size-3" />
              Add a teammate — a secretary, a marketer…
            </button>
          </li>
        ) : null}
      </ul>
      <AssistantOnboardingDialog />
    </li>
  );
});
