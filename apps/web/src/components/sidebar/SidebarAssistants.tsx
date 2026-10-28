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
import { ChevronRightIcon, MoonIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, memo, useState } from "react";
import { create } from "zustand";

import { useAssistantChat } from "../../assistant/useAssistantChat";
import { ensureAssistantChat } from "../../lib/managerApi";
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
import { AsleepAssistantSheet, MachineTag } from "../assistants/MachineAssistants";
import {
  type MachineAssistant,
  type MachineGroup,
  assistantFullName,
  openComputerSwitcher,
  useAssistantsByMachine,
  useAssistantsLayout,
  useAsleepSheet,
} from "../assistants/perMachine";
import { type TeamMember, useTeamShown } from "../assistants/useAssistantTeam";
import { useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  /** Variant B: the computer it lives on, as a tag after its name. */
  readonly machineLabel?: string | undefined;
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
      // Variant B: its main chat on its own computer (the daemon there makes it).
      leave();
      void ensureAssistantChat({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId as ProjectId,
      }).then(({ threadId }) =>
        navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({
            environmentId: member.environmentId as EnvironmentId,
            threadId,
          }),
        }),
      );
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
            {props.machineLabel ? assistantFullName(name, props.machineLabel) : name} ·{" "}
            {member.configured ? status : "Not set up yet"} — open its page
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
          {props.machineLabel ? <MachineTag label={props.machineLabel} /> : null}
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

/** A sleeping computer's assistant: grey, "asleep"; a click says why and what to do. */
function AsleepAssistantRow(props: {
  readonly assistant: MachineAssistant;
  readonly showMachine: boolean;
}) {
  const { assistant } = props;
  const show = useAsleepSheet((state) => state.show);
  return (
    <li
      className="list-none"
      data-testid="sidebar-assistant-asleep"
      data-assistant={assistant.projectId}
    >
      <button
        type="button"
        onClick={() => show(assistant)}
        title={`${assistantFullName(assistant.name, assistant.machine.label)} is asleep`}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-1 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="ml-1 inline-flex size-6 shrink-0 items-center justify-center opacity-55 grayscale">
          <AssistantAvatar emoji={assistant.isUno ? null : assistant.emoji} tone={assistant.tone} />
        </span>
        <span className="min-w-0 truncate text-sm text-sidebar-muted-foreground">
          {assistant.name}
        </span>
        {props.showMachine ? <MachineTag label={assistant.machine.label} asleep /> : null}
        {!props.showMachine ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 pr-1 text-[10px] text-muted-foreground">
            <MoonIcon className="size-2.5" /> asleep
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Many assistants on several computers: a small header per computer (B1, more than 6). */
function MachineSubheader(props: {
  readonly group: MachineGroup;
  readonly folded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={props.onToggle}
        className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pr-1 pl-2.5 text-left text-[11px] text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        data-testid="sidebar-assistants-machine"
      >
        <ChevronRightIcon
          className={cn("size-3 transition-transform", !props.folded && "rotate-90")}
        />
        <span className="truncate">{props.group.label}</span>
        <span className="text-sidebar-muted-foreground/50">
          · {props.group.assistants.length}
          {props.group.awake ? "" : " · asleep"}
        </span>
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
  const teamShown = useTeamShown();
  const unfolded = useUnfoldedStore((state) => state.keys);
  const setUnfolded = useUnfoldedStore((state) => state.set);
  const navigate = useNavigate();
  const layout = useAssistantsLayout((state) => state.layout);
  const groups = useAssistantsByMachine();
  const header = assistantsHeaderState({ teamShown });
  const [foldedMachines, setFoldedMachines] = useState<ReadonlySet<string>>(() => new Set());
  const current = groups.find((group) => group.current) ?? groups[0] ?? null;
  const several = groups.length > 1;
  const shown = layout === "switcher" ? (current ? [current] : []) : groups;
  const total = shown.reduce((sum, group) => sum + group.assistants.length, 0);
  // Many on several computers: a small header per computer, sleeping ones folded.
  const byMachine = layout === "group" && several && total > 6;
  const elsewhere = layout === "switcher" ? groups.filter((group) => group !== current) : [];
  const elsewhereCount = elsewhere.reduce((sum, group) => sum + group.assistants.length, 0);
  const firstElsewhere = elsewhere[0]?.assistants[0] ?? null;

  const isFolded = (group: MachineGroup) => foldedMachines.has(group.key) !== !group.awake; // asleep: folded unless opened
  const toggleMachine = (group: MachineGroup) =>
    setFoldedMachines((keys) => {
      const next = new Set(keys);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });

  const row = (assistant: MachineAssistant, showMachine: boolean) =>
    assistant.member && assistant.awake ? (
      <AssistantRow
        key={assistant.key}
        member={assistant.member}
        machineLabel={showMachine ? assistant.machine.label : undefined}
        unfolded={unfolded.has(assistant.key)}
        onToggle={() => setUnfolded(assistant.key, !unfolded.has(assistant.key))}
        routeThreadKey={props.routeThreadKey}
        extraChats={assistant.isUno && assistant.machine.current ? props.unoRunning : []}
        renderChat={props.renderChat}
      />
    ) : (
      <AsleepAssistantRow key={assistant.key} assistant={assistant} showMachine={showMachine} />
    );

  const create = () =>
    void navigate({
      to: "/assistants",
      search: {
        view: "gallery",
        ...(current?.environmentId ? { env: current.environmentId } : {}),
      },
    } as never);

  return (
    <li className="list-none pb-1" data-testid="sidebar-assistants" data-layout={layout}>
      {header.showHeader ? (
        <div
          className="flex h-6 items-center justify-between pr-1 pl-2.5"
          data-testid="sidebar-assistants-header"
        >
          <span className="min-w-0 truncate text-xs font-medium text-sidebar-muted-foreground/70">
            {layout === "switcher" && current && several ? (
              <>
                Assistants{" "}
                <span className="text-sidebar-muted-foreground/50">· {current.label}</span>
              </>
            ) : (
              "Assistants"
            )}
          </span>
          {header.showCreate ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="New assistant"
                    onClick={create}
                    data-testid="sidebar-new-assistant"
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">
                New assistant — pick a character, pick a computer
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      <ul role="list" className="flex flex-col gap-px">
        {byMachine
          ? shown.flatMap((group) => [
              <MachineSubheader
                key={`h-${group.key}`}
                group={group}
                folded={isFolded(group)}
                onToggle={() => toggleMachine(group)}
              />,
              ...(isFolded(group)
                ? []
                : group.assistants.map((assistant) => row(assistant, false))),
            ])
          : shown.flatMap((group) =>
              group.assistants.map((assistant) => row(assistant, several && layout === "group")),
            )}
        {groups.length === 0 ? <UnoFallbackRow /> : null}
        {layout === "switcher" && firstElsewhere ? (
          <li className="list-none">
            <button
              type="button"
              onClick={openComputerSwitcher}
              className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-2.5 text-left text-[11px] text-sidebar-muted-foreground/60 hover:text-sidebar-foreground"
              data-testid="sidebar-assistants-elsewhere"
            >
              <span className="truncate">
                {assistantFullName(firstElsewhere.name, firstElsewhere.machine.label)}
                {elsewhereCount > 1 ? ` and ${elsewhereCount - 1} more` : ""} — in the computer
                switcher ↗
              </span>
            </button>
          </li>
        ) : null}
      </ul>
      <AssistantOnboardingDialog />
      <AsleepAssistantSheet />
    </li>
  );
});
