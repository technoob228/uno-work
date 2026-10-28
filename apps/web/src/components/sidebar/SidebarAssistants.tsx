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
 * Variant D (Misha 28.10): the gear next to "+" opens the assistants'
 * settings; the eye hides the whole block (one "Show assistants" line stays);
 * an assistant's group of chats folds even while one of them is open; one Uno
 * per account (the home computer's), personas from other computers say which.
 * The chats an assistant started are in the common list ("started by").
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
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, memo, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

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
import { useAccountHomeEnvironmentId } from "../assistants/accountUno";
import { useQuickCreateAssistant } from "../assistants/useQuickCreateAssistant";
import { type TeamMember, useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";
import { useSidebar } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIMPLE_SETTINGS_PATHS } from "../settings/settingsNavGroups";
import {
  type AssistantFoldChoice,
  assistantChatsUnfolded,
  assistantRowNote,
  assistantRowTarget,
  assistantsHeaderState,
  toggledFoldChoice,
  unoSetupHref,
} from "./sidebarAssistants.logic";
import { sidebarDPanel } from "./sidebarDState";

const OPEN_KEY = "sidebar:assistants-open:v1";
/** Groups the person folded while one of their chats was open (28.10). */
const CLOSED_KEY = "sidebar:assistants-closed:v1";
/** The whole block hidden by the person (28.10). */
const HIDDEN_KEY = "sidebar:assistants-hidden:v1";

function readKeys(storageKey: string): ReadonlyArray<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeKeys(storageKey: string, keys: ReadonlySet<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {
    // fine: kept for this session
  }
}

const threadKeyOf = (thread: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The person's fold choice per assistant, kept across reloads. */
const useUnfoldedStore = create<{
  readonly open: ReadonlySet<string>;
  readonly closed: ReadonlySet<string>;
  readonly set: (key: string, choice: "open" | "closed") => void;
}>((set, get) => ({
  open: new Set(typeof localStorage === "undefined" ? [] : readKeys(OPEN_KEY)),
  closed: new Set(typeof localStorage === "undefined" ? [] : readKeys(CLOSED_KEY)),
  set: (key, choice) => {
    const open = new Set(get().open);
    const closed = new Set(get().closed);
    if (choice === "open") {
      open.add(key);
      closed.delete(key);
    } else {
      open.delete(key);
      closed.add(key);
    }
    writeKeys(OPEN_KEY, open);
    writeKeys(CLOSED_KEY, closed);
    set({ open, closed });
  },
}));

const foldChoiceOf = (
  state: { readonly open: ReadonlySet<string>; readonly closed: ReadonlySet<string> },
  key: string,
): AssistantFoldChoice =>
  state.open.has(key) ? "open" : state.closed.has(key) ? "closed" : undefined;

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
}

/** The assistants block hidden or shown (this device; shown by default). */
export const useAssistantsSectionStore = create<{
  readonly hidden: boolean;
  readonly setHidden: (hidden: boolean) => void;
}>((set) => ({
  hidden: typeof localStorage === "undefined" ? false : readHidden(),
  setHidden: (hidden) => {
    try {
      localStorage.setItem(HIDDEN_KEY, String(hidden));
    } catch {
      // fine: for this session
    }
    set({ hidden });
  },
}));

/** Unfolds an assistant's chats from outside the sidebar (its page, the demo). */
export function unfoldAssistantInSidebar(key: string) {
  useUnfoldedStore.getState().set(key, "open");
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
  readonly foldChoice: AssistantFoldChoice;
  readonly onFoldChange: (choice: "open" | "closed") => void;
  /** The small line after the name: its role (and its computer, when not home). */
  readonly note: { readonly text: string; readonly computer: string | null };
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
  // Untouched, the group opens while one of its chats is open; the person's
  // own fold wins (28.10: a group holding the open chat could not be folded).
  const unfolded = assistantChatsUnfolded({
    choice: props.foldChoice,
    holdsOpenChat,
    chatCount: chats.length,
  });
  const preview = previewChats(chats, { showAll, isOpen });
  const latest = latestConversation(member.chats);
  // Folded with its open chat inside: the row itself says "you are here".
  const rowActive = !unfolded && holdsOpenChat;

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
    const target = assistantRowTarget({
      configured: member.configured,
      isUno: member.isUno,
      teamShown,
      environmentId: member.environmentId,
    });
    if (target.kind === "uno-setup") {
      // Uno's first run lives on the assistants page, not in a dialog that
      // opened on every click (audit 27.10, line 15).
      leave();
      void navigate({ href: unoSetupHref(target.environmentId) });
      return;
    }
    if (target.kind === "setup") {
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
            {name} · {member.configured ? status : "Not set up yet"}
            {props.note.computer ? ` · on ${props.note.computer}` : ""} — open its page
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
          {/* One signal for "waits for you": the dot (the Inbox counts it too). */}
          {!member.configured ? (
            <span className="shrink-0 text-xs text-primary">Set up</span>
          ) : (
            // Variant D: a persona is a channel with a role; Uno's is everything.
            <span
              className="ml-auto max-w-[45%] shrink-0 truncate pr-1.5 text-[11px] text-sidebar-muted-foreground/60 group-hover/assistant:hidden"
              data-testid="sidebar-assistant-role"
            >
              {props.note.text}
            </span>
          )}
        </button>
        {chats.length > 0 ? (
          <HoverButton
            label={unfolded ? `Fold ${name}'s chats` : `${name}'s chats (${chats.length})`}
            onClick={() => props.onFoldChange(toggledFoldChoice(unfolded))}
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
        <ul
          role="list"
          className="flex flex-col gap-px"
          data-testid="sidebar-assistant-chats"
          data-assistant={member.projectId}
        >
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

/** A small icon button of the "Assistants" header. */
function HeaderButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly hoverOnly?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            data-testid={props.testId}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              props.hoverOnly &&
                "opacity-0 transition-opacity group-hover/assistants-header:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
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

export const SidebarAssistants = memo(function SidebarAssistants(props: {
  readonly routeThreadKey: string | null;
  /** Uno's work chats that are still running (the sidebar keeps them under Uno). */
  readonly unoRunning: ReadonlyArray<SidebarThreadSummary>;
  readonly renderChat: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const team = useAssistantTeam();
  const teamShown = useTeamShown();
  const foldState = useUnfoldedStore(
    useShallow((state) => ({ open: state.open, closed: state.closed })),
  );
  const setFold = useUnfoldedStore((state) => state.set);
  const hidden = useAssistantsSectionStore((state) => state.hidden);
  const setHidden = useAssistantsSectionStore((state) => state.setHidden);
  const quick = useQuickCreateAssistant();
  const navigate = useNavigate();
  const homeEnvironmentId = useAccountHomeEnvironmentId();
  const { isMobile, setOpenMobile } = useSidebar();
  const live = team.filter((member) => !member.revoked);
  const multiComputer = new Set(live.map((member) => member.environmentId)).size > 1;
  const header = assistantsHeaderState({ teamShown, hidden });
  const [showAllPersonas, setShowAllPersonas] = useState(false);
  // Variant D: many personas fold after the first few (Uno always shows).
  const FOLD = 7;
  const shown = showAllPersonas ? live : live.slice(0, FOLD);
  const more = live.length - shown.length;
  const leave = () => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
  };
  // "+" opens the gallery of personas (Grok-style), not a nameless one-click assistant.
  const openGallery = () => {
    leave();
    void navigate({ to: "/assistants", search: { view: "new" } });
  };
  const openSettings = () => {
    leave();
    void navigate({ to: SIMPLE_SETTINGS_PATHS.assistants });
  };

  if (header.showRestore) {
    // Hidden by the person: one small line brings the block back.
    return (
      <li className="list-none pb-1" data-testid="sidebar-assistants">
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pl-2.5 text-left text-xs text-sidebar-muted-foreground/60 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="sidebar-show-assistants"
        >
          <EyeIcon className="size-3" />
          Show assistants
        </button>
      </li>
    );
  }

  return (
    <li className="list-none pb-1" data-testid="sidebar-assistants">
      {header.showHeader ? (
        <div
          className="group/assistants-header flex h-6 items-center gap-0.5 pr-1 pl-2.5"
          data-testid="sidebar-assistants-header"
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/70">
            Assistants
          </span>
          <HeaderButton
            label="Hide assistants"
            onClick={() => setHidden(true)}
            testId="sidebar-hide-assistants"
            hoverOnly
          >
            <EyeOffIcon className="size-3.5" />
          </HeaderButton>
          {header.showSettings ? (
            <HeaderButton
              label="Assistant settings"
              onClick={openSettings}
              testId="sidebar-assistants-settings"
            >
              <SettingsIcon className="size-3.5" />
            </HeaderButton>
          ) : null}
          {header.showCreate ? (
            <HeaderButton
              label="New assistant"
              onClick={openGallery}
              disabled={quick.creating || !quick.available}
              testId="sidebar-new-assistant"
            >
              {quick.creating ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
            </HeaderButton>
          ) : null}
        </div>
      ) : null}
      <ul role="list" className="flex flex-col gap-px">
        {shown.map((member) => (
          <AssistantRow
            key={member.key}
            member={member}
            foldChoice={foldChoiceOf(foldState, member.key)}
            onFoldChange={(choice) => setFold(member.key, choice)}
            // Gating (28.10): no notes beside the rows without the assistants update (0.0.156).
            note={
              teamShown
                ? assistantRowNote({
                    isUno: member.isUno,
                    role: member.profile.roles[0] ?? null,
                    environmentId: member.environmentId,
                    homeEnvironmentId,
                    computerLabel: member.computerLabel,
                    multiComputer,
                  })
                : { text: "", computer: null }
            }
            routeThreadKey={props.routeThreadKey}
            extraChats={member.isUno ? props.unoRunning : []}
            renderChat={props.renderChat}
          />
        ))}
        {live.length === 0 ? <UnoFallbackRow /> : null}
        {more > 0 || (showAllPersonas && live.length > FOLD) ? (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setShowAllPersonas((value) => !value)}
              className="flex h-6 w-full cursor-pointer items-center rounded-md pr-2 pl-9 text-left text-xs text-sidebar-muted-foreground/60 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="sidebar-assistants-more"
            >
              {more > 0 ? `Show ${more} more` : "Show less"}
            </button>
          </li>
        ) : null}
      </ul>
      <AssistantOnboardingDialog />
    </li>
  );
});
