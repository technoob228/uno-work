/**
 * The chat-list sidebar: every chat in one flat list, newest first, not
 * grouped by project. Ported from upstream T3 Code's Sidebar v2 (#4026, made
 * default in #5672, header row #11315, bottom shelves #11595); the old
 * project-grouped sidebar lives on as `LegacySidebar.tsx` behind the Labs
 * "Sidebar (legacy)" switch, like upstream.
 *
 * Layout, top to bottom: search row (search + project scope + new project +
 * new chat), then Pinned and Active chats as cards (project / title / branch),
 * then the Snoozed shelf and the paged Settled tail, which sit at the bottom
 * while the list is short.
 *
 * What differs from upstream, and why:
 * - Data comes from this fork's zustand store (`selectSidebarThreads*`), not
 *   upstream's client-runtime atoms, and honours the fork's machine scope
 *   (Labs "All machines in one sidebar").
 * - Sections come from `Sidebar.sections.ts`: idle auto-settle is computed on
 *   the client, manual settle is server-backed (`thread.settle`).
 * - No drag between sections, no drafts block, no compact rail: the fork has
 *   no pin/active order keys, and upstream reverted the rail (#11685).
 * - Fork features kept: machine chips and offline marks on remote chats, the
 *   bot mark on agent-spawned chats, Helper (assistant) chats kept out of the
 *   main list and reachable through the project scope and the footer,
 *   "Continue on another machine", the snooze "Pick time" dialog.
 */
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CloudOffIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PlusIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  Undo2Icon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import {
  isAssistantProjectId,
  type ContextMenuItem,
  type EnvironmentId,
  type ProviderDriverKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime";

import { describeSpawnedThreadOrigin } from "../agentThreads.logic";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isElectron } from "../env";
import { useEnvironmentSupportsAgentThreads } from "../environments/agentThreadsSupport";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { readEnvironmentApi } from "../environmentApi";
import {
  readEnvironmentSupportsThreadSettlement,
  useEnvironmentSupportsThreadSettlement,
} from "../environments/threadSettlementSupport";
import {
  readEnvironmentSupportsThreadSnooze,
  useEnvironmentSupportsThreadSnooze,
} from "../environments/threadSnoozeSupport";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useFeatureFlag } from "../hooks/useFeatureFlags";
import { useFolderChats, useHomeFolderPath } from "../hooks/useFolderChats";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { useSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { useThreadTitle } from "../hooks/useThreadTitle";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useGitStatus } from "../lib/gitStatusState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newCommandId } from "../lib/utils";
import { getProjectOrderKey } from "../logicalProject";
import { readLocalApi } from "../localApi";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import { useShortcutModifierState } from "../shortcutModifierState";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForEnvironment,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { CONTINUE_ON_MACHINE_COPY } from "../continueOnMachineCopy";
import { ContinueOnMachineDialog } from "./ContinueOnMachineDialog";
import { MachineChip } from "./MachineChip";
import { MachineIdentityProvider, useMachineIdentity } from "./MachineIdentityContext";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  compactSidebarTimeLabel,
  filterSidebarProjectScopeItems,
  getSidebarThreadIdsToPrewarm,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarProjectScope,
  resolveSidebarThreadEnvironmentAvailability,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
  formatWorkingDurationLabel,
  searchSidebarThreads,
  shouldClearThreadSelectionOnMouseDown,
  shouldCreateNewThreadInCurrentProject,
  shouldRecedeSidebarThread,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import {
  partitionSidebarThreads,
  resolveSettledThreadTimestamp,
  type SidebarSection,
} from "./Sidebar.sections";
import {
  canSnoozeThread,
  formatSnoozePickerValue,
  parseSnoozePickerValue,
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
} from "./Sidebar.snooze";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarComputerRow } from "./sidebar/SidebarComputerRow";
import { SidebarSetupRow } from "./sidebar/SidebarSetupRow";
import { SidebarEmptyProjects } from "./sidebar/SidebarEmptyProjects";
import { SidebarMyUnoRow } from "./sidebar/SidebarMyUnoRow";
import { SidebarEnvSwitcher } from "./SidebarEnvSwitcher";
import { SidebarAppsList } from "./sidebar/SidebarAppsList";
import { SidebarFilesTree } from "./sidebar/SidebarFilesTree";
import { SidebarModeSwitch } from "./sidebar/SidebarModeSwitch";
import { SidebarPinned } from "./sidebar/SidebarPinned";
import { type SidebarMode, useNavStore } from "../navigation/navStore";
import { useNavLayout } from "../navigation/useNavLayout";
import { InboxNeedsYouList, InboxPanel } from "./inbox/InboxPanel";
import { RailPanelHeader } from "./sidebar/NavRail";
import { SidebarAssistantRow } from "./sidebar/SidebarAssistantRow";
import { useShowAssistantInSidebar } from "../assistant/assistantPrefs";
import { isAssistantConversation } from "@t3tools/shared/assistantChat";
import { SidebarNewButton } from "./sidebar/SidebarNewButton";
import {
  ASSISTANT_CHAT_NAME,
  isFromAssistant,
  isOlderAssistantChat,
  isRegularListChat,
} from "../assistant/assistantChat.logic";
import { useAssistantChat } from "../assistant/useAssistantChat";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import {
  useSidebarEnvironmentLabelResolver,
  useSidebarMachineIdentities,
} from "./sidebar/useSidebarMachineIdentities";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { SidebarContent, SidebarFooter, SidebarGroup, useSidebar } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
// Shelves start collapsed; the choice persists per device like upstream.
const SETTLED_SHELF_EXPANDED_KEY = "uno-work:sidebar:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "uno-work:sidebar:snoozed-expanded";
// The project scope survives routes that unmount the sidebar and restarts.
const PROJECT_SCOPE_KEY = "uno-work:sidebar:project-scope";
/** Scope value for the Helper (assistant) chats, which stay out of "All projects". */
const HELPER_SCOPE = "helper";
const ALL_SCOPE = "all";

const EMPTY_THREADS: readonly SidebarThreadSummary[] = [];

function threadKeyOf(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function projectKeyOf(thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">): string {
  return `${thread.environmentId}:${thread.projectId}`;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Settled rows read "how long ago did this wrap up", matching their sort key.
function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledThreadTimestamp(thread);
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Floats at the row's right edge while the jump modifier is held, without
// displacing the status label or shifting layout.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>;
}

function resolveProviderDriverKind(
  thread: SidebarThreadSummary,
  providerDriverByInstanceId: ReadonlyMap<string, ProviderDriverKind>,
): ProviderDriverKind | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection?.instanceId;
  const fromInstance =
    instanceId !== undefined ? providerDriverByInstanceId.get(instanceId) : undefined;
  if (fromInstance !== undefined) return fromInstance;
  if (thread.session?.provider) return thread.session.provider;
  // Default instance ids are driver slugs ("codex", "claudeAgent"), which is
  // all a chat on another machine can tell us without that machine's config.
  if (instanceId !== undefined && instanceId in PROVIDER_ICON_BY_PROVIDER) {
    return instanceId as ProviderDriverKind;
  }
  return null;
}

/**
 * Bot mark on a chat another chat's agent created, naming that chat. Hidden
 * when the chat's machine does not advertise `agentThreads`.
 */
/** "Uno" pill on a chat the assistant started (the "from Uno" label). */
const SidebarFromUnoBadge = memo(function SidebarFromUnoBadge(props: { threadId: ThreadId }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Started by Uno"
            data-testid={`thread-from-uno-${props.threadId}`}
            className="inline-flex shrink-0 items-center rounded-full bg-primary/12 px-1.5 text-[10px] leading-4 font-medium text-primary"
          />
        }
      >
        {ASSISTANT_CHAT_NAME}
      </TooltipTrigger>
      <TooltipPopup side="top">Started by Uno</TooltipPopup>
    </Tooltip>
  );
});

const SidebarSpawnedThreadBadge = memo(function SidebarSpawnedThreadBadge(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  spawnedByThreadId: ThreadId;
}) {
  const supported = useEnvironmentSupportsAgentThreads(props.environmentId);
  const parentTitle = useThreadTitle(props.environmentId, props.spawnedByThreadId);
  // A chat Uno's own agent spawned reads "from Uno", like the ones it starts.
  const parentIsUno = useStore(
    (state) =>
      selectEnvironmentState(state, props.environmentId).sidebarThreadSummaryById[
        props.spawnedByThreadId
      ]?.assistantRole === "chat",
  );
  if (parentIsUno) return <SidebarFromUnoBadge threadId={props.threadId} />;
  if (!supported) return null;
  const label = describeSpawnedThreadOrigin(parentTitle);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-testid={`thread-spawned-badge-${props.threadId}`}
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground/70"
          />
        }
      >
        <BotIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
});

/** Snooze presets behind the clock on a hovered card. */
function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (snoozedUntil: string) => void;
  onPickTime: () => void;
}) {
  const { open, onOpenChange, onSnooze, onPickTime } = props;
  // Presets resolve at open time so "In 1 hour" is relative to the click.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  const stop = useCallback((event: SyntheticEvent) => event.stopPropagation(), []);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Snooze chat"
              onClick={stop}
              onDoubleClick={stop}
              className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
            />
          }
        >
          <AlarmClockIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Snooze chat</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44" onClick={stop}>
        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Snooze until</div>
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => onSnooze(preset.snoozedUntil)}>
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {snoozeWakeDescription(preset.snoozedUntil, new Date())}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onPickTime}>Pick time…</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// Structural shelf header: label, hairline, chevron. Snoozed reads blue.
function SidebarSectionHeader(props: {
  kind: "snoozed" | "settled";
  label: string;
  className?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const snoozed = props.kind === "snoozed";
  return (
    <li data-thread-selection-safe className={cn("mx-0.5 h-8 list-none", props.className)}>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        data-testid={`sidebar-${props.kind}-shelf-toggle`}
        className={cn(
          "flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium",
          snoozed ? "text-blue-600 dark:text-blue-400" : "text-sidebar-muted-foreground/60",
        )}
      >
        <span className="shrink-0">{props.label}</span>
        <span
          aria-hidden
          className={cn(
            "h-px min-w-2 flex-1",
            snoozed ? "bg-blue-500/20 dark:bg-blue-400/15" : "bg-border",
          )}
        />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-180")}
        />
      </button>
    </li>
  );
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  section: SidebarSection;
  isActive: boolean;
  jumpLabel: string | null;
  now: string;
  project: Project | null;
  projectDisplayName: string | null;
  primaryEnvironmentId: EnvironmentId | null;
  providerDriverByInstanceId: ReadonlyMap<string, ProviderDriverKind>;
  isRenaming: boolean;
  renamingTitle: string;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, snoozedUntil: string) => void;
  onPickSnoozeTime: (threadRef: ScopedThreadRef) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onOpenPrLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    thread,
    variant,
    section,
    isRenaming,
    renamingTitle,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onSettle,
    onSnooze,
    onPickSnoozeTime,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    onOpenPrLink,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const settlementSupported = useEnvironmentSupportsThreadSettlement(thread.environmentId);
  const snoozeSupported = useEnvironmentSupportsThreadSnooze(thread.environmentId);

  // Machine awareness: a chat on another machine carries that machine's chip,
  // and a warning when the machine is unreachable.
  const isRemote =
    props.primaryEnvironmentId !== null && thread.environmentId !== props.primaryEnvironmentId;
  const machineIdentity = useMachineIdentity(thread.environmentId);
  const environmentLabel = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const savedEnvironmentLabel = useSavedEnvironmentRegistryStore(
    (s) => s.byId[thread.environmentId]?.label ?? null,
  );
  const connectionState = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.connectionState ?? null,
  );
  const lastSynchronizedAt = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.lastSynchronizedAt ?? null,
  );
  const availability = useMemo(
    () =>
      resolveSidebarThreadEnvironmentAvailability({
        isPrimaryEnvironment: !isRemote,
        environmentLabel: environmentLabel ?? savedEnvironmentLabel ?? "Remote",
        connectionState,
        lastSynchronizedAt,
      }),
    [connectionState, environmentLabel, isRemote, lastSynchronizedAt, savedEnvironmentLabel],
  );

  // PR state comes from the checkout's git status, only for cards (slim
  // history rows would open a watcher per settled chat).
  const gitCwd = thread.worktreePath ?? props.project?.cwd ?? null;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: variant === "card" && thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  // Pinned chats sit with the other pins and never recede like history.
  const isPinnedRow = section === "pinned";
  const shouldRecede =
    !isPinnedRow &&
    shouldRecedeSidebarThread({
      status,
      isUnread,
      isActive: props.isActive,
      isSelected,
    });
  // Status hues follow the system-wide convention: amber approval, indigo
  // input, sky working, red failed, emerald for an unread completion.
  const topStatus =
    status === "working"
      ? { label: "Working", icon: "working" as const, className: "text-sky-600 dark:text-sky-400" }
      : status === "approval"
        ? {
            label: "Approval",
            icon: "approval" as const,
            className: "text-amber-700 dark:text-amber-300",
          }
        : status === "input"
          ? {
              label: "Input",
              icon: "input" as const,
              className: "text-indigo-600 dark:text-indigo-300",
            }
          : status === "failed"
            ? {
                label: "Failed",
                icon: "failed" as const,
                className: "text-red-700 dark:text-red-300",
              }
            : isUnread
              ? {
                  label: "Done",
                  icon: "done" as const,
                  className: "text-emerald-700 dark:text-emerald-300",
                }
              : null;

  const driverKind = resolveProviderDriverKind(thread, props.providerDriverByInstanceId);
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton = snoozeSupported && canSnoozeThread(thread, props.now);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const canSettle = settlementSupported && status !== "working" && status !== "approval";

  const handleClick = useCallback(
    (event: ReactMouseEvent) => onThreadClick(event, threadRef),
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) onCommitRename(threadRef, renamingTitle, thread.title);
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const stopAnd = useCallback(
    (action: (threadRef: ScopedThreadRef) => void) => (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      action(threadRef);
    },
    [threadRef],
  );
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (prStatus) onOpenPrLink(event, prStatus.url);
    },
    [onOpenPrLink, prStatus],
  );

  // One surface model for every row: status lives in the content, surface is
  // reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-1 focus-visible:ring-ring",
    section === "settled" && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected
        ? "bg-sidebar-row-selected text-sidebar-foreground ring-1 ring-inset ring-primary/30"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
  );

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Chat title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      data-testid={`thread-title-${thread.id}`}
      className={cn(
        "min-w-0 flex-1 truncate text-sm",
        shouldRecede ? "font-normal" : "font-medium",
        variant === "card"
          ? shouldRecede
            ? "text-secondary-label"
            : isUnread || status === "input"
              ? "text-foreground"
              : "text-foreground/90"
          : cn(
              "group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
              props.isActive || status === "input"
                ? "text-foreground"
                : isPinnedRow
                  ? "text-sidebar-foreground/90"
                  : isUnread
                    ? "text-muted-foreground"
                    : "text-secondary-label/70",
            ),
      )}
    >
      {thread.title}
    </span>
  );

  const spawnedBadge = isFromAssistant(thread, null) ? (
    <SidebarFromUnoBadge threadId={thread.id} />
  ) : thread.spawnedByThreadId ? (
    <SidebarSpawnedThreadBadge
      environmentId={thread.environmentId}
      threadId={thread.id}
      spawnedByThreadId={thread.spawnedByThreadId}
    />
  ) : null;
  const pinIndicator =
    thread.pinnedAt != null ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin chat"
              onClick={stopAnd(onUnpin)}
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <PinIcon aria-hidden className="size-3 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup>Unpin chat</TooltipPopup>
      </Tooltip>
    ) : null;
  const terminalStatusIcon = terminalStatus ? (
    <span
      role="img"
      aria-label={terminalStatus.label}
      title={terminalStatus.label}
      className={cn("inline-flex shrink-0 items-center justify-center", terminalStatus.colorClass)}
    >
      <TerminalIcon className={cn("size-3.5", terminalStatus.pulse && "animate-pulse")} />
    </span>
  ) : null;
  const prBadge = prStatus ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            onClick={handlePrClick}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap border-b border-transparent text-xs tabular-nums hover:border-current focus-visible:outline-2 focus-visible:outline-ring",
              prStatus.colorClass,
            )}
          />
        }
      >
        <ChangeRequestStatusIcon className="size-3" />
        {pr?.number}
      </TooltipTrigger>
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
  ) : null;
  const machineMark = isRemote ? (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <MachineChip
        className={availability.status === "live" ? undefined : "opacity-60"}
        detail={availability.reason}
        identity={machineIdentity}
        size="sm"
      />
      {availability.status === "offline" ? (
        <Tooltip>
          <TooltipTrigger
            render={<span aria-label={availability.reason} className="inline-flex items-center" />}
          >
            <CloudOffIcon className="block size-3 text-warning" />
          </TooltipTrigger>
          <TooltipPopup side="top">{availability.reason}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  ) : null;

  if (variant === "slim") {
    const isSnoozedRow = section === "snoozed";
    const slimActionClassName =
      "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100";
    return (
      <li data-thread-item className="list-none">
        <div
          role="button"
          tabIndex={0}
          data-testid="sidebar-row-slim"
          data-sidebar-section={section}
          className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
        >
          {/* History recedes: dimmed favicon at rest, restored on hover. */}
          <span
            className={cn(
              "flex shrink-0 transition-opacity",
              !isPinnedRow &&
                (!props.isActive || section === "settled") &&
                "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
            )}
          >
            {props.project ? (
              <ProjectFavicon
                environmentId={props.project.environmentId}
                cwd={props.project.cwd}
                className="size-4"
              />
            ) : (
              <FolderIcon className="size-4 text-muted-foreground/50" />
            )}
          </span>
          {spawnedBadge}
          {title}
          {pinIndicator}
          {terminalStatusIcon}
          {machineMark}
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
            <span className="inline-flex justify-end tabular-nums text-secondary-label transition-opacity group-hover/sidebar-row:opacity-0">
              {isSnoozedRow && thread.snoozedUntil != null ? (
                // Snoozed rows show when they come back, not when last touched.
                <span
                  className="text-xs text-blue-600 tabular-nums dark:text-blue-400"
                  title={`Snoozed until ${snoozeWakeDescription(thread.snoozedUntil, new Date(props.now))}`}
                >
                  {snoozeWakeLabel(thread.snoozedUntil, props.now)}
                </span>
              ) : (
                <span className="text-xs">
                  {section === "settled" ? settledTimeLabel(thread) : threadTimeLabel(thread)}
                </span>
              )}
            </span>
            {isSnoozedRow ? (
              snoozeSupported ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Wake chat now"
                        onClick={stopAnd(onUnsnooze)}
                        className={slimActionClassName}
                      />
                    }
                  >
                    <AlarmClockOffIcon className="mb-px size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Wake now</TooltipPopup>
                </Tooltip>
              ) : null
            ) : settlementSupported ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Un-settle chat"
                      onClick={stopAnd(onUnsettle)}
                      className={slimActionClassName}
                    />
                  }
                >
                  <Undo2Icon className="mb-px size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">Un-settle chat</TooltipPopup>
              </Tooltip>
            ) : null}
          </span>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </div>
      </li>
    );
  }

  return (
    <li data-thread-item className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-row-card"
        data-sidebar-section={section}
        className={rowSurfaceClassName}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <div className="relative z-10 h-[4.875rem] px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon
                environmentId={props.project.environmentId}
                cwd={props.project.cwd}
                className="size-4 shrink-0"
              />
            ) : null}
            {props.projectDisplayName ? (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-secondary-label",
                  shouldRecede ? "font-normal" : "font-medium",
                )}
              >
                {props.projectDisplayName}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {pinIndicator}
            {/* The visible state owns this slot's width: status at rest,
                actions on hover / keyboard focus or while the menu is open. */}
            <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span
                className={cn(
                  "pointer-events-none flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                  (canSettle || showSnoozeButton) &&
                    "group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
                  snoozeMenuOpen && "absolute right-0 opacity-0",
                )}
              >
                {topStatus ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 font-medium",
                      topStatus.className,
                    )}
                  >
                    {topStatus.icon === "working" ? (
                      <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                    ) : topStatus.icon === "input" ? (
                      <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
                    ) : topStatus.icon === "approval" ? (
                      <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                    ) : topStatus.icon === "failed" ? (
                      <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                    ) : (
                      <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                    )}
                    <span role="status">{topStatus.label}</span>
                    {status === "working" ? (
                      <span aria-hidden>
                        <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                      </span>
                    ) : null}
                  </span>
                ) : (
                  threadTimeLabel(thread)
                )}
              </span>
              {canSettle || showSnoozeButton ? (
                <span
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:static group-hover/sidebar-row:opacity-100",
                    snoozeMenuOpen && "pointer-events-auto static opacity-100",
                  )}
                >
                  {showSnoozeButton ? (
                    <SnoozeMenuButton
                      open={snoozeMenuOpen}
                      onOpenChange={setSnoozeMenuOpen}
                      onSnooze={(snoozedUntil) => onSnooze(threadRef, snoozedUntil)}
                      onPickTime={() => onPickSnoozeTime(threadRef)}
                    />
                  ) : null}
                  {canSettle ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Settle chat"
                            onClick={stopAnd(onSettle)}
                            className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                          />
                        }
                      >
                        <CheckIcon className="size-3.5" />
                        Settle
                      </TooltipTrigger>
                      <TooltipPopup>Settle chat: move it to the settled list</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            {spawnedBadge}
            {title}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
            {/* Always the branch: the row's most stable identifier. */}
            {thread.branch ? (
              <>
                {thread.worktreePath ? (
                  <span
                    role="img"
                    aria-label={`Worktree: ${formatWorktreePathForDisplay(thread.worktreePath)}`}
                    title={`Worktree: ${formatWorktreePathForDisplay(thread.worktreePath)}`}
                    className="inline-flex items-center justify-center"
                  >
                    <FolderGit2Icon className="size-3 text-muted-foreground/40" />
                  </span>
                ) : (
                  <GitBranchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
                )}
                <span className="min-w-0 flex-1 truncate whitespace-nowrap text-muted-foreground/40">
                  {thread.branch}
                </span>
              </>
            ) : (
              <span className="flex-1" />
            )}
            {terminalStatusIcon}
            {prBadge}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1">
              {machineMark}
              {driverKind ? (
                <ProviderInstanceIcon
                  driverKind={driverKind}
                  displayName={thread.modelSelection?.model ?? driverKind}
                  iconClassName="size-3.5 opacity-60"
                />
              ) : null}
            </span>
          </div>
        </div>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </div>
    </li>
  );
});

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  thread: SidebarThreadSummary;
  project: Project | null;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const { thread, project } = props;
  return (
    <li role="presentation" className="list-none">
      <button
        id={props.resultId}
        type="button"
        role="option"
        // aria-activedescendant options: focus stays on the search input.
        tabIndex={-1}
        aria-selected={props.isHighlighted}
        aria-current={props.isRouteActive ? "page" : undefined}
        onMouseMove={props.onHighlight}
        onClick={props.onSelect}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none",
          props.isHighlighted || props.isRouteActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        {project ? (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            className="size-4 shrink-0"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
          {threadTimeLabel(thread)}
        </span>
      </button>
    </li>
  );
});

function useErrorToast() {
  return useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
}

export default function Sidebar() {
  const sidebarMode = useNavStore((state) => state.sidebarMode);
  const lastListMode = useNavStore((state) => state.lastListMode);
  const setSidebarMode = useNavStore((state) => state.setSidebarMode);
  // Rail layout: this sidebar is the panel next to the rail and shows one
  // section at a time. Standard layout: "Home" lives in the main area, so a
  // "home" left over from the rail reads as Chats.
  const railLayout = useNavLayout() === "rail";
  // Standard layout (0.0.83): "Home" lives in the main area and the Inbox is
  // the bell's popover, so a "home" or "inbox" left over from the rail (or an
  // older version) reads as Chats — the chat list never disappears behind the
  // Inbox, and Home and Inbox are never highlighted together.
  const listMode: SidebarMode = railLayout
    ? sidebarMode
    : sidebarMode === "home" || sidebarMode === "inbox"
      ? "chats"
      : sidebarMode;
  const pathname = useLocation({ select: (location) => location.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const showErrorToast = useErrorToast();

  // ── Data: projects and chats in the machine scope ────────────────────
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const allMachinesSidebar = useFeatureFlag("allMachinesSidebar");
  const environmentScopeSetting = useSettings((s) => s.sidebarEnvironmentScope);
  const machineScope = useMemo(
    () =>
      resolveSidebarProjectScope({
        scope: allMachinesSidebar ? environmentScopeSetting : "active",
        activeEnvironmentId,
        primaryEnvironmentId,
      }),
    [activeEnvironmentId, allMachinesSidebar, environmentScopeSetting, primaryEnvironmentId],
  );
  const projects = useStore(
    useShallow((store) =>
      machineScope.kind === "all-environments"
        ? selectProjectsAcrossEnvironments(store)
        : selectProjectsForEnvironment(
            store,
            machineScope.kind === "environment" ? machineScope.environmentId : null,
          ),
    ),
  );
  const threads = useStore(
    useShallow((store) =>
      machineScope.kind === "all-environments"
        ? selectSidebarThreadsAcrossEnvironments(store)
        : selectSidebarThreadsForEnvironment(
            store,
            machineScope.kind === "environment" ? machineScope.environmentId : null,
          ),
    ),
  );
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const confirmThreadDelete = useSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useSettings((s) => s.confirmThreadArchive);
  const defaultThreadEnvMode = useSettings((s) => s.defaultThreadEnvMode);
  const projectGroupingSettings = useSettings(
    useShallow((settings) => ({
      sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
      sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
    })),
  );
  const keybindings = useServerKeybindings();
  const serverProviders = useServerProviders();
  const providerDriverByInstanceId = useMemo(
    () =>
      new Map<string, ProviderDriverKind>(
        serverProviders.map((provider) => [provider.instanceId, provider.driver]),
      ),
    [serverProviders],
  );
  const resolveEnvironmentLabel = useSidebarEnvironmentLabelResolver();
  const projectEnvironmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const machineIdentities = useSidebarMachineIdentities({
    primaryEnvironmentId,
    projectEnvironmentIds,
    resolveEnvironmentLabel,
  });

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
      }),
    [projectOrder, projects],
  );
  // Logical groups (one repository on several machines is one project) name
  // the rows and fill the scope picker. Helper projects stay out of it.
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel,
      }).filter((group) => !isAssistantProjectId(group.id)),
    [orderedProjects, primaryEnvironmentId, projectGroupingSettings, resolveEnvironmentLabel],
  );
  // The Uno chat (pinned on top) and the assistant's other chats, which the
  // "Older Uno chats" scope lists when there are any.
  const assistantChatId = useAssistantChat().chat?.id ?? null;
  const [showAssistantRow] = useShowAssistantInSidebar();
  const hasHelperProjects = useMemo(
    () =>
      threads.some(
        (thread) => thread.archivedAt === null && isOlderAssistantChat(thread, assistantChatId),
      ),
    [assistantChatId, threads],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of projectGroups) {
      for (const member of group.memberProjects) {
        map.set(`${member.environmentId}:${member.id}`, group.displayName);
      }
    }
    for (const project of projects) {
      if (isAssistantProjectId(project.id)) {
        map.set(`${project.environmentId}:${project.id}`, ASSISTANT_CHAT_NAME);
      }
    }
    return map;
  }, [projectGroups, projects]);

  // ── Project scope ─────────────────────────────────────────────────────
  const [projectScopeKey, setProjectScopeKey] = useLocalStorage<string | null, string | null>(
    PROJECT_SCOPE_KEY,
    null,
    Schema.NullOr(Schema.String),
  );
  const projectScopeItems = useMemo(
    () => [
      { value: ALL_SCOPE, label: "All projects" },
      ...(hasHelperProjects ? [{ value: HELPER_SCOPE, label: "Uno conversations" }] : []),
      ...projectGroups.map((group) => ({ value: group.projectKey, label: group.displayName })),
    ],
    [hasHelperProjects, projectGroups],
  );
  const projectGroupByScopeKey = useMemo(
    () => new Map(projectGroups.map((group) => [group.projectKey, group] as const)),
    [projectGroups],
  );
  const scopedProjectGroup: SidebarProjectSnapshot | null =
    projectScopeKey !== null ? (projectGroupByScopeKey.get(projectScopeKey) ?? null) : null;
  const isHelperScope = projectScopeKey === HELPER_SCOPE && hasHelperProjects;
  const selectedProjectScopeItem =
    projectScopeItems.find((item) => item.value === (projectScopeKey ?? ALL_SCOPE)) ??
    projectScopeItems[0]!;
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const filteredProjectScopeItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items: projectScopeItems,
        query: projectScopeMenuState.query,
        matches: (item, query) =>
          projectScopeFilter.contains(item, query, (candidate) => candidate.label),
      }),
    [projectScopeFilter, projectScopeItems, projectScopeMenuState.query],
  );
  // A scope whose project is gone (removed, or on a machine now out of scope)
  // falls back to all projects once projects have loaded.
  useEffect(() => {
    if (projectScopeKey === null || projects.length === 0) return;
    if (projectScopeKey === HELPER_SCOPE ? !hasHelperProjects : scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [hasHelperProjects, projectScopeKey, projects.length, scopedProjectGroup, setProjectScopeKey]);
  const headerSearchRef = useRef<HTMLDivElement | null>(null);

  // ── Route and selection ───────────────────────────────────────────────
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const selectedThreadCount = useThreadSelectionStore((s) => s.selectedThreadKeys.size);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  // Scope flips drop the selection: bulk actions must never touch hidden rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  // ── Sections ──────────────────────────────────────────────────────────
  const now = useMinuteClock();
  const { pinnedThreads, activeThreads, snoozedThreads, settledThreads } = useMemo(() => {
    const visible = threads.filter((thread) => {
      if (thread.archivedAt !== null) return false;
      // The Uno chat is pinned on top of the sidebar, never in the list.
      if (assistantChatId !== null && thread.id === assistantChatId) return false;
      const isOlderUnoChat = isOlderAssistantChat(thread, assistantChatId);
      if (isHelperScope) return isOlderUnoChat;
      // The assistant's other chats (older ones, Telegram / Slack chats) live
      // behind the "Older Uno chats" scope; the open one stays visible.
      if (!isRegularListChat(thread, assistantChatId)) {
        // A conversation with Uno shows under the Uno row (unfolded while
        // it is open), never twice.
        if (showAssistantRow && isAssistantConversation(thread)) return false;
        return threadKeyOf(thread) === routeThreadKey;
      }
      return scopedProjectKeys === null || scopedProjectKeys.has(projectKeyOf(thread));
    });
    const sections = partitionSidebarThreads(visible, { now, sortOrder: sidebarThreadSortOrder });
    return {
      pinnedThreads: sections.pinned,
      activeThreads: sections.active,
      snoozedThreads: sections.snoozed,
      settledThreads: sections.settled,
    };
  }, [
    assistantChatId,
    isHelperScope,
    now,
    routeThreadKey,
    showAssistantRow,
    scopedProjectKeys,
    sidebarThreadSortOrder,
    threads,
  ]);

  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey = projectScopeKey ?? ALL_SCOPE;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    // The open chat never hides under "Show more".
    const routeThread = settledThreads
      .slice(settledVisibleCount)
      .find((thread) => threadKeyOf(thread) === routeThreadKey);
    if (routeThread !== undefined) visible.push(routeThread);
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    const routeThread = visibleSettledThreads.find(
      (thread) => threadKeyOf(thread) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);
  const renderedSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    const routeThread = snoozedThreads.find((thread) => threadKeyOf(thread) === routeThreadKey);
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  const orderedThreads = useMemo(
    () => [
      ...pinnedThreads,
      ...activeThreads,
      ...renderedSnoozedThreads,
      ...renderedSettledThreads,
    ],
    [activeThreads, pinnedThreads, renderedSettledThreads, renderedSnoozedThreads],
  );
  const orderedThreadKeys = useMemo(() => orderedThreads.map(threadKeyOf), [orderedThreads]);
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [threadKeyOf(thread), thread] as const)),
    [threads],
  );
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  const sectionByKey = useMemo(
    () =>
      new Map<string, SidebarSection>([
        ...pinnedThreads.map((thread) => [threadKeyOf(thread), "pinned"] as const),
        ...activeThreads.map((thread) => [threadKeyOf(thread), "active"] as const),
        ...snoozedThreads.map((thread) => [threadKeyOf(thread), "snoozed"] as const),
        ...settledThreads.map((thread) => [threadKeyOf(thread), "settled"] as const),
      ]),
    [activeThreads, pinnedThreads, settledThreads, snoozedThreads],
  );
  // Handlers read these through refs so rows keep stable callback props.
  const sectionByKeyRef = useRef(sectionByKey);
  sectionByKeyRef.current = sectionByKey;

  // Keep the chats near the top warm so opening one reuses a live subscription.
  const prewarmedThreadRefs = useMemo(
    () =>
      getSidebarThreadIdsToPrewarm(orderedThreadKeys).flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [orderedThreadKeys],
  );
  useEffect(() => {
    const releases = prewarmedThreadRefs.map((ref) =>
      retainThreadDetailSubscription(ref.environmentId, ref.threadId),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [prewarmedThreadRefs]);

  // ── Navigation ────────────────────────────────────────────────────────
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) clearSelection();
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );
  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isModClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) return;
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );
  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadCount === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [clearSelection, selectedThreadCount]);

  // ── Search ────────────────────────────────────────────────────────────
  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const threadSearchResults = useMemo(
    () =>
      searchSidebarThreads(
        [...pinnedThreads, ...activeThreads, ...snoozedThreads, ...settledThreads],
        threadSearchQuery,
      ),
    [activeThreads, pinnedThreads, settledThreads, snoozedThreads, threadSearchQuery],
  );
  const threadSearchResultOrderKey = threadSearchResults.map(threadKeyOf).join("\0");
  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);
  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);
  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: SidebarThreadSummary) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition uses the same keys.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResultIndex(
          (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  // ── Thread actions ────────────────────────────────────────────────────
  const { archiveThread, deleteThread } = useThreadActions();
  const dispatch = useCallback(
    async (
      threadRef: ScopedThreadRef,
      command: Parameters<
        NonNullable<ReturnType<typeof readEnvironmentApi>>["orchestration"]["dispatchCommand"]
      >[0],
    ) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) throw new Error("This machine is not connected.");
      await api.orchestration.dispatchCommand(command);
    },
    [],
  );
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      const trimmed = title.trim();
      setRenamingThreadKey(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Chat title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      dispatch(threadRef, {
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        title: trimmed,
      }).catch((error) => showErrorToast("Failed to rename chat", error));
    },
    [dispatch, showErrorToast],
  );
  const setThreadPinned = useCallback(
    (threadRef: ScopedThreadRef, pinned: boolean) => {
      dispatch(threadRef, {
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        pinnedAt: pinned ? new Date().toISOString() : null,
      }).catch((error) =>
        showErrorToast(pinned ? "Failed to pin chat" : "Failed to unpin chat", error),
      );
    },
    [dispatch, showErrorToast],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => setThreadPinned(threadRef, false),
    [setThreadPinned],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      dispatch(threadRef, {
        type: "thread.unsnooze",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        reason: "user",
      }).catch((error) => showErrorToast("Failed to wake chat", error));
    },
    [dispatch, showErrorToast],
  );
  // Parking the chat you are looking at (settle or snooze) moves you forward
  // to the next remaining card, like upstream. Background parks stay put.
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
      if (routeThreadKeyRef.current !== threadKey) return null;
      const orderedKeys = orderedThreadKeysRef.current;
      const sections = sectionByKeyRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      if (currentIndex === -1) return null;
      const nextKey =
        [...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
          (key) =>
            (sections.get(key) === "active" || sections.get(key) === "pinned") &&
            !coParkingKeys?.has(key),
        ) ?? null;
      const nextThread = nextKey ? threadByKeyRef.current.get(nextKey) : undefined;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : null;
    },
    [navigateToThread],
  );
  const attemptSnooze = useCallback(
    (threadRef: ScopedThreadRef, snoozedUntil: string, coParkingKeys?: ReadonlySet<string>) => {
      const threadKey = scopedThreadKey(threadRef);
      const navigateAfter = planForwardNavigation(threadKey, coParkingKeys);
      dispatch(threadRef, {
        type: "thread.snooze",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        snoozedUntil,
      })
        .then(() => {
          if (routeThreadKeyRef.current === threadKey) navigateAfter?.();
          // Snooze hides the row, so the toast is the confirmation and Undo
          // is the escape hatch for a mis-click.
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(snoozedUntil, new Date())}`,
              description: "It comes back on its own, or sooner if the agent needs you.",
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(threadRef),
              },
            }),
          );
        })
        .catch((error) => showErrorToast("Failed to snooze chat", error));
    },
    [attemptUnsnooze, dispatch, planForwardNavigation, showErrorToast],
  );
  const settlingThreadKeysRef = useRef(new Set<string>());
  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, coParkingKeys?: ReadonlySet<string>) => {
      const threadKey = scopedThreadKey(threadRef);
      // One settle per chat at a time: a double click must not toast a false error.
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const navigateAfter = planForwardNavigation(threadKey, coParkingKeys);
      dispatch(threadRef, {
        type: "thread.settle",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      })
        .then(() => {
          if (routeThreadKeyRef.current === threadKey) navigateAfter?.();
        })
        .catch((error) => showErrorToast("Failed to settle chat", error))
        .finally(() => settlingThreadKeysRef.current.delete(threadKey));
    },
    [dispatch, planForwardNavigation, showErrorToast],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      dispatch(threadRef, {
        type: "thread.unsettle",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        reason: "user",
      }).catch((error) => showErrorToast("Failed to un-settle chat", error));
    },
    [dispatch, showErrorToast],
  );
  const openPrLink = useCallback((event: ReactMouseEvent<HTMLElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }
    void api.shell.openExternal(url).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);

  const [snoozePickerTarget, setSnoozePickerTarget] = useState<ScopedThreadRef | null>(null);
  const [snoozePickerValue, setSnoozePickerValue] = useState("");
  const openSnoozePicker = useCallback((threadRef: ScopedThreadRef) => {
    const defaultWake = new Date(Date.now() + 2 * 60 * 60 * 1_000);
    defaultWake.setMinutes(0, 0, 0);
    setSnoozePickerValue(formatSnoozePickerValue(defaultWake));
    setSnoozePickerTarget(threadRef);
  }, []);
  const snoozePickerWake = useMemo(
    () => parseSnoozePickerValue(snoozePickerValue, new Date()),
    [snoozePickerValue],
  );
  const submitSnoozePicker = useCallback(() => {
    if (!snoozePickerTarget || snoozePickerWake === null) return;
    attemptSnooze(snoozePickerTarget, snoozePickerWake);
    setSnoozePickerTarget(null);
  }, [attemptSnooze, snoozePickerTarget, snoozePickerWake]);
  const [continueThreadTarget, setContinueThreadTarget] = useState<ScopedThreadRef | null>(null);

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: "Path copied", description: path }),
    onError: (error) => showErrorToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) =>
      toastManager.add({ type: "success", title: "Chat ID copied", description: threadId }),
    onError: (error) => showErrorToast("Failed to copy chat ID", error),
  });

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // Only keys whose rows exist: selections can outlive their rows.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter((key) =>
        threadByKeyRef.current.has(key),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreads = threadKeys.flatMap((key) => {
        const thread = threadByKeyRef.current.get(key);
        return thread ? [thread] : [];
      });
      const canSettleSelection = selectedThreads.every((thread) =>
        readEnvironmentSupportsThreadSettlement(thread.environmentId),
      );
      const nowIso = new Date().toISOString();
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          readEnvironmentSupportsThreadSnooze(thread.environmentId) &&
          canSnoozeThread(thread, nowIso),
      );
      const snoozePresets = resolveSnoozePresets(new Date());
      const clicked = await api.contextMenu.show(
        [
          ...(canSettleSelection ? [{ id: "settle", label: `Settle (${count})` }] : []),
          ...(canSnoozeSelection
            ? [
                {
                  id: "snooze",
                  label: `Snooze (${count})`,
                  children: snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}`,
                    label: preset.label,
                  })),
                },
              ]
            : []),
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );
      const coParkingKeys = new Set(threadKeys);
      if (typeof clicked === "string" && clicked.startsWith("snooze:")) {
        const preset = snoozePresets.find((entry) => `snooze:${entry.id}` === clicked);
        if (preset) {
          clearSelection();
          for (const thread of selectedThreads) {
            attemptSnooze(
              scopeThreadRef(thread.environmentId, thread.id),
              preset.snoozedUntil,
              coParkingKeys,
            );
          }
        }
        return;
      }
      if (clicked === "settle") {
        clearSelection();
        for (const thread of selectedThreads) {
          if (thread.settledOverride === "settled") continue;
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id), coParkingKeys);
        }
        return;
      }
      if (clicked === "mark-unread") {
        for (const thread of selectedThreads) {
          markThreadUnread(threadKeyOf(thread), thread.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} chat${count === 1 ? "" : "s"}?`,
            "This permanently clears the conversation history of these chats.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }
      const deletedThreadKeys = new Set(threadKeys);
      for (const thread of selectedThreads) {
        await deleteThread(scopeThreadRef(thread.environmentId, thread.id), { deletedThreadKeys });
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptSettle,
      attemptSnooze,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selection = useThreadSelectionStore.getState().selectedThreadKeys;
        if (selection.size > 0 && selection.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        if (selection.size > 0) clearSelection();
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const section = sectionByKeyRef.current.get(threadKey) ?? "active";
        const project = projectByKey.get(projectKeyOf(thread)) ?? null;
        const workspacePath = thread.worktreePath ?? project?.cwd ?? null;
        const isPinned = thread.pinnedAt != null;
        const nowDate = new Date();
        const supportsSettlement = readEnvironmentSupportsThreadSettlement(thread.environmentId);
        const supportsSnooze = readEnvironmentSupportsThreadSnooze(thread.environmentId);
        const status = resolveSidebarThreadStatus(thread);
        const snoozePresets = resolveSnoozePresets(nowDate);
        const lifecycleItems: ContextMenuItem[] = [];
        if (supportsSettlement) {
          lifecycleItems.push(
            section === "settled"
              ? { id: "unsettle", label: "Un-settle chat" }
              : {
                  id: "settle",
                  label: "Settle chat",
                  disabled: status === "working" || status === "approval",
                },
          );
        }
        if (supportsSnooze) {
          lifecycleItems.push(
            section === "snoozed" && thread.snoozedUntil != null
              ? {
                  id: "unsnooze",
                  label: `Wake now (snoozed until ${snoozeWakeDescription(thread.snoozedUntil, nowDate)})`,
                }
              : {
                  id: "snooze",
                  label: "Snooze",
                  disabled: !canSnoozeThread(thread, nowDate.toISOString()),
                  children: [
                    ...snoozePresets.map((preset) => ({
                      id: `snooze:${preset.id}`,
                      label: preset.label,
                    })),
                    { id: "snooze:pick", label: "Pick time…" },
                  ],
                },
          );
        }
        const clicked = await api.contextMenu.show(
          [
            { id: "rename", label: "Rename chat" },
            { id: "pin", label: isPinned ? "Unpin chat" : "Pin chat" },
            ...lifecycleItems,
            { id: "mark-unread", label: "Mark unread" },
            { id: "copy-path", label: "Copy Path" },
            { id: "copy-thread-id", label: "Copy chat ID" },
            { id: "continue-on-machine", label: CONTINUE_ON_MACHINE_COPY.action },
            { id: "archive", label: "Archive" },
            { id: "delete", label: "Delete", destructive: true },
          ],
          position,
        );
        if (clicked === "snooze:pick") {
          openSnoozePicker(threadRef);
          return;
        }
        if (typeof clicked === "string" && clicked.startsWith("snooze:")) {
          const preset = snoozePresets.find((entry) => `snooze:${entry.id}` === clicked);
          if (preset) attemptSnooze(threadRef, preset.snoozedUntil);
          return;
        }
        switch (clicked) {
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "pin":
            setThreadPinned(threadRef, !isPinned);
            return;
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "copy-path":
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This chat does not have a project folder to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "continue-on-machine":
            setContinueThreadTarget(threadRef);
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await api.dialogs.confirm(`Archive chat "${thread.title}"?`);
              if (!confirmed) return;
            }
            try {
              await archiveThread(threadRef);
            } catch (error) {
              showErrorToast("Failed to archive chat", error);
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await api.dialogs.confirm(
                [
                  `Delete chat "${thread.title}"?`,
                  "This permanently clears the conversation history of this chat.",
                ].join("\n"),
              );
              if (!confirmed) return;
            }
            await deleteThread(threadRef);
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      attemptSettle,
      attemptSnooze,
      attemptUnsettle,
      attemptUnsnooze,
      clearSelection,
      confirmThreadArchive,
      confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      openSnoozePicker,
      projectByKey,
      setThreadPinned,
      showErrorToast,
      startThreadRename,
    ],
  );

  // ── Keyboard: jump (mod+1..9) and previous/next traversal ─────────────
  const modelPickerOpen = useModelPickerOpen();
  const platform = navigator.platform;
  const routeTerminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand, {
        platform,
        context: { terminalFocus: false, terminalOpen: routeTerminalOpen },
      });
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys, platform, routeTerminalOpen]);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const shortcutModifiers = useShortcutModifierState();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: { terminalFocus: false, terminalOpen: routeTerminalOpen, modelPickerOpen },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return;
        const targetThread = threadByKeyRef.current.get(targetThreadKey);
        if (!targetThread) return;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    modelPickerOpen,
    navigateToThread,
    orderedThreadKeys,
    platform,
    routeTerminalOpen,
    routeThreadKey,
  ]);

  // ── New chat / new project ────────────────────────────────────────────
  const newThreadContext = useHandleNewThread();
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const openNewThreadIn = useCommandPaletteStore((store) => store.openNewThreadIn);
  const folderChats = useFolderChats(newThreadContext.activeEnvironmentId);
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
      if (isMobile) setOpenMobile(false);
      const envMode = resolveSidebarNewThreadEnvMode({ defaultEnvMode: defaultThreadEnvMode });
      // Scoped to a project: the new chat belongs there.
      const scopedMember = scopedProjectGroup?.memberProjects[0];
      if (scopedMember) {
        void newThreadContext.handleNewThread(
          scopeProjectRef(scopedMember.environmentId, scopedMember.id),
          { envMode },
        );
        return;
      }
      const startInCurrentProject = () =>
        startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          defaultThreadEnvMode: envMode,
          handleNewThread: newThreadContext.handleNewThread,
          activeEnvironmentId: newThreadContext.activeEnvironmentId,
          createStarterProject: newThreadContext.createStarterProject,
          onMissingProject: openAddProject,
        });
      // Shift: a new chat in the project of the chat that's open.
      if (event?.shiftKey) {
        void startInCurrentProject();
        return;
      }
      // New chat starts right away in the home folder; the folder chip on the
      // chat picks another folder.
      void folderChats.chatInHomeFolder().then((started) => {
        if (started) return;
        // Home folder unreachable: the pre-0.0.82 behaviour.
        if (shouldCreateNewThreadInCurrentProject(false, projectGroups.length)) {
          void startInCurrentProject();
        } else {
          openNewThreadIn();
        }
      });
    },
    [
      defaultThreadEnvMode,
      folderChats,
      isMobile,
      newThreadContext,
      openAddProject,
      openNewThreadIn,
      projectGroups.length,
      scopedProjectGroup,
      setOpenMobile,
    ],
  );
  // "New chat" on the rail: this sidebar knows which project it goes to.
  const newChatRequest = useNavStore((state) => state.newChatRequest);
  const handledNewChatRequest = useRef(newChatRequest);
  useEffect(() => {
    if (newChatRequest === handledNewChatRequest.current) return;
    handledNewChatRequest.current = newChatRequest;
    handleNewThreadClick();
  }, [handleNewThreadClick, newChatRequest]);
  // "New ▾ → New chat in a project": the projects used last on this computer.
  const homeFolderPath = useHomeFolderPath(newThreadContext.activeEnvironmentId);
  const newMenuProjects = useMemo(() => {
    const home = homeFolderPath?.replace(/\/+$/, "") ?? null;
    return projects
      .filter(
        (project) =>
          !isAssistantProjectId(project.id) &&
          project.environmentId === newThreadContext.activeEnvironmentId &&
          project.cwd.replace(/\/+$/, "") !== home,
      )
      .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 5)
      .map((project) => ({
        key: `${project.environmentId}:${project.id}`,
        name: projectDisplayNameByKey.get(`${project.environmentId}:${project.id}`) ?? project.name,
        onSelect: () => {
          if (isMobile) setOpenMobile(false);
          void newThreadContext.handleNewThread(
            scopeProjectRef(project.environmentId, project.id),
            {
              envMode: resolveSidebarNewThreadEnvMode({ defaultEnvMode: defaultThreadEnvMode }),
            },
          );
        },
      }));
  }, [
    defaultThreadEnvMode,
    homeFolderPath,
    isMobile,
    newThreadContext,
    projectDisplayNameByKey,
    projects,
    setOpenMobile,
  ]);
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new", platform);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "chat.newLocal",
    platform,
  );

  if (isOnSettings) {
    return (
      <MachineIdentityProvider identities={machineIdentities}>
        <SidebarChromeHeader isElectron={isElectron} />
        <SettingsSidebarNav pathname={pathname} />
      </MachineIdentityProvider>
    );
  }

  const renderRow = (thread: SidebarThreadSummary, section: SidebarSection) => {
    const threadKey = threadKeyOf(thread);
    // Pinned chats live in the compact Pinned group above every sidebar mode.
    const variant = section === "active" ? "card" : "slim";
    const projectKey = projectKeyOf(thread);
    return (
      <SidebarThreadRow
        key={`${threadKey}:${variant}`}
        thread={thread}
        variant={variant}
        section={section}
        isActive={routeThreadKey === threadKey}
        jumpLabel={showThreadJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
        now={now}
        project={projectByKey.get(projectKey) ?? null}
        projectDisplayName={projectDisplayNameByKey.get(projectKey) ?? null}
        primaryEnvironmentId={primaryEnvironmentId}
        providerDriverByInstanceId={providerDriverByInstanceId}
        isRenaming={renamingThreadKey === threadKey}
        renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
        onThreadClick={handleThreadClick}
        onThreadActivate={navigateToThread}
        onStartRename={startThreadRename}
        onRenameTitleChange={setRenamingTitle}
        onCommitRename={commitThreadRename}
        onCancelRename={cancelThreadRename}
        onContextMenu={handleThreadContextMenu}
        onSettle={attemptSettle}
        onUnsettle={attemptUnsettle}
        onSnooze={attemptSnooze}
        onPickSnoozeTime={openSnoozePicker}
        onUnsnooze={attemptUnsnooze}
        onUnpin={attemptUnpin}
        onOpenPrLink={openPrLink}
      />
    );
  };
  // Pinned chats render in the Pinned group, not in the list below.
  const totalThreadCount = activeThreads.length + snoozedThreads.length + settledThreads.length;

  const projectScopePicker: ReactNode = (
    <Combobox
      items={projectScopeItems}
      filteredItems={filteredProjectScopeItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectScopeMenuState.open}
      onOpenChange={(open) => dispatchProjectScopeMenu({ type: "open-changed", open })}
      value={selectedProjectScopeItem}
      onValueChange={(item) => {
        if (!item) return;
        setProjectScopeKey(item.value === ALL_SCOPE ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={
              scopedProjectGroup
                ? `Filter chats by project: ${scopedProjectGroup.displayName}`
                : isHelperScope
                  ? "Filter chats by project: Uno conversations"
                  : "Filter chats by project"
            }
          />
        }
      >
        {scopedProjectGroup ? (
          // Wrapped so the button's svg color rule cannot override the favicon.
          <span className="flex shrink-0">
            <ProjectFavicon
              environmentId={scopedProjectGroup.environmentId}
              cwd={scopedProjectGroup.cwd}
              className="size-4"
            />
          </span>
        ) : isHelperScope ? (
          <BotIcon className="size-4 text-foreground" />
        ) : (
          <FolderIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        // Anchored to the search field so the popup is at least as wide as it.
        anchor={headerSearchRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={projectScopeMenuState.query}
          onChange={(event) =>
            dispatchProjectScopeMenu({ type: "query-changed", query: event.target.value })
          }
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList className="p-1">
          {(item: (typeof projectScopeItems)[number]) => {
            const group = projectGroupByScopeKey.get(item.value) ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                className="h-8 min-h-8 py-0 font-medium"
                contentClassName="flex min-w-0 items-center gap-2"
              >
                {group ? (
                  <ProjectFavicon
                    environmentId={group.environmentId}
                    cwd={group.cwd}
                    className="size-4 shrink-0"
                  />
                ) : item.value === HELPER_SCOPE ? (
                  <BotIcon className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {group && group.environmentPresence !== "local-only" ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {group.remoteEnvironmentLabels.join(", ")}
                  </span>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );

  const pinnedGroup = (
    <SidebarGroup
      className={cn(
        "shrink-0 overflow-y-auto px-[var(--sidebar-content-inset)] pt-1 pb-1",
        !railLayout && "max-h-[40%]",
      )}
    >
      <SidebarPinned
        hasPinnedChats={pinnedThreads.length > 0}
        pinnedChats={pinnedThreads.map((thread) => renderRow(thread, "pinned"))}
      />
    </SidebarGroup>
  );

  return (
    <MachineIdentityProvider identities={machineIdentities}>
      {railLayout ? (
        <RailPanelHeader mode={listMode} isElectron={isElectron} />
      ) : (
        <SidebarChromeHeader isElectron={isElectron} showBell />
      )}
      {railLayout ? (
        listMode === "home" ? (
          <SidebarGroup className="shrink-0 px-[var(--sidebar-content-inset)] pt-1 pb-0">
            <SidebarEnvSwitcher variant="header" />
            <SidebarSetupRow />
            <SidebarMyUnoRow />
          </SidebarGroup>
        ) : null
      ) : (
        <SidebarGroup className="shrink-0 px-[var(--sidebar-content-inset)] pt-1 pb-0">
          <SidebarEnvSwitcher variant="header" />
          <SidebarSetupRow />
          <SidebarAssistantRow />
          <SidebarComputerRow />
          <SidebarMyUnoRow />
          <div className="pt-1.5 pb-1">
            <SidebarModeSwitch />
          </div>
        </SidebarGroup>
      )}
      {!railLayout || listMode === "home" ? pinnedGroup : null}
      {listMode === "home" ? (
        <SidebarContent className="min-h-full gap-0 border-t border-border/50">
          <SidebarGroup className="px-[var(--sidebar-content-inset)] pt-1.5 pb-1">
            <InboxNeedsYouList />
          </SidebarGroup>
        </SidebarContent>
      ) : listMode === "inbox" ? (
        <SidebarContent
          className={cn("min-h-full gap-0", !railLayout && "border-t border-border/50")}
        >
          <SidebarGroup className="min-h-full flex-1 px-[var(--sidebar-content-inset)] pt-1 pb-1">
            <InboxPanel
              showTitle={!railLayout}
              {...(railLayout ? {} : { onBack: () => setSidebarMode(lastListMode) })}
            />
          </SidebarGroup>
        </SidebarContent>
      ) : listMode === "files" ? (
        <SidebarContent className="min-h-full gap-0 border-t border-border/50">
          <SidebarGroup className="px-[var(--sidebar-content-inset)] pt-1.5 pb-1">
            <SidebarFilesTree />
          </SidebarGroup>
        </SidebarContent>
      ) : listMode === "apps" ? (
        <SidebarContent className="min-h-full gap-0 border-t border-border/50">
          <SidebarGroup className="min-h-full flex-1 px-[var(--sidebar-content-inset)] pt-1.5 pb-1">
            <SidebarAppsList />
          </SidebarGroup>
        </SidebarContent>
      ) : (
        <>
          <SidebarGroup className="shrink-0 border-t border-border/50 px-[var(--sidebar-content-inset)] pt-1.5 pb-1">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projects.length > 0}
              projectScope={projectScopePicker}
              newButton={
                <SidebarNewButton
                  onNewChat={handleNewThreadClick}
                  disabled={projects.length === 0 && newThreadContext.activeEnvironmentId === null}
                  shortcutLabel={newThreadShortcutLabel}
                  inProjectShortcutLabel={newThreadInProjectShortcutLabel}
                  recentProjects={newMenuProjects}
                />
              }
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setActiveSearchResultIndex(0);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
          <SidebarContent className="min-h-full gap-0">
            <SidebarGroup className="min-h-full flex-1 ps-[calc(var(--sidebar-content-inset)+1px)] pe-[var(--sidebar-content-inset)] pt-0 pb-1">
              {isSearchingThreads ? (
                threadSearchResults.length > 0 ? (
                  <ul
                    id="sidebar-thread-search-results"
                    role="listbox"
                    aria-label="Chat search results"
                    className="flex flex-col gap-px"
                  >
                    {threadSearchResults.map((thread, index) => {
                      const threadKey = threadKeyOf(thread);
                      return (
                        <SidebarSearchResultRow
                          key={threadKey}
                          thread={thread}
                          project={projectByKey.get(projectKeyOf(thread)) ?? null}
                          isHighlighted={activeSearchResultIndex === index}
                          isRouteActive={routeThreadKey === threadKey}
                          resultId={`sidebar-thread-search-result-${index}`}
                          onHighlight={() => setActiveSearchResultIndex(index)}
                          onSelect={() => selectThreadSearchResult(thread)}
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p
                    role="status"
                    className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
                  >
                    No chats found
                  </p>
                )
              ) : (
                <TooltipProvider delay={150} closeDelay={0} timeout={400}>
                  <ul
                    role="list"
                    className={cn(
                      "relative flex flex-col gap-px",
                      totalThreadCount > 0 && "flex-1",
                    )}
                  >
                    {activeThreads.map((thread) => renderRow(thread, "active"))}
                    {snoozedThreads.length > 0 ? (
                      <SidebarSectionHeader
                        kind="snoozed"
                        className="mt-auto"
                        label={
                          snoozedShelfExpanded ? "Snoozed" : `Snoozed (${snoozedThreads.length})`
                        }
                        expanded={snoozedShelfExpanded}
                        onToggle={() => setSnoozedShelfExpanded((value) => !value)}
                      />
                    ) : null}
                    {renderedSnoozedThreads.map((thread) => renderRow(thread, "snoozed"))}
                    {settledThreads.length > 0 ? (
                      <SidebarSectionHeader
                        kind="settled"
                        className={cn(snoozedThreads.length === 0 && "mt-auto")}
                        label={
                          settledShelfExpanded ? "Settled" : `Settled (${settledThreads.length})`
                        }
                        expanded={settledShelfExpanded}
                        onToggle={() => setSettledShelfExpanded((value) => !value)}
                      />
                    ) : null}
                    {renderedSettledThreads.map((thread) => renderRow(thread, "settled"))}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={() =>
                            setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT)
                          }
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          <PlusIcon aria-hidden className="size-4 shrink-0" />
                          Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </TooltipProvider>
              )}
              {!isSearchingThreads &&
              totalThreadCount === 0 &&
              pinnedThreads.length === 0 &&
              !scopedProjectGroup &&
              !isHelperScope ? (
                <SidebarEmptyProjects
                  projects={projectGroups.map((group) => ({
                    key: group.projectKey,
                    name: group.displayName,
                  }))}
                  onOpen={(key) => {
                    const member = projectGroupByScopeKey.get(key)?.memberProjects[0];
                    if (!member) return;
                    if (isMobile) setOpenMobile(false);
                    void newThreadContext.handleNewThread(
                      scopeProjectRef(member.environmentId, member.id),
                      {
                        envMode: resolveSidebarNewThreadEnvMode({
                          defaultEnvMode: defaultThreadEnvMode,
                        }),
                      },
                    );
                  }}
                />
              ) : null}
              {!isSearchingThreads &&
              totalThreadCount === 0 &&
              pinnedThreads.length === 0 &&
              (projects.length === 0 || scopedProjectGroup || isHelperScope) ? (
                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                  {projects.length === 0 ? (
                    <>
                      <span>No chats yet</span>
                      <Button size="xs" variant="outline" onClick={() => handleNewThreadClick()}>
                        <PlusIcon className="-mx-0.5 size-3" />
                        New chat in your home folder
                      </Button>
                      <Button size="xs" variant="ghost" onClick={openAddProject}>
                        Add project
                      </Button>
                    </>
                  ) : scopedProjectGroup ? (
                    `No chats in ${scopedProjectGroup.displayName} yet`
                  ) : isHelperScope ? (
                    "No older Uno chats"
                  ) : (
                    "No chats yet"
                  )}
                </div>
              ) : null}
            </SidebarGroup>
          </SidebarContent>
        </>
      )}
      {railLayout ? (
        <SidebarFooter className="gap-1 px-[var(--sidebar-content-inset)] py-1.5">
          <SidebarUpdatePill />
        </SidebarFooter>
      ) : (
        <SidebarChromeFooter />
      )}

      <ContinueOnMachineDialog
        threadRef={continueThreadTarget}
        open={continueThreadTarget !== null}
        onOpenChange={(open) => {
          if (!open) setContinueThreadTarget(null);
        }}
      />
      <Dialog
        open={snoozePickerTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozePickerTarget(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>
              The chat moves to Snoozed and comes back at this time, or sooner if the agent needs
              you.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <Input
              type="datetime-local"
              aria-label="Wake up time"
              value={snoozePickerValue}
              min={formatSnoozePickerValue(new Date())}
              onChange={(event) => setSnoozePickerValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitSnoozePicker();
                }
              }}
            />
            {snoozePickerValue !== "" && snoozePickerWake === null ? (
              <p className="text-xs text-destructive">Pick a time in the future.</p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnoozePickerTarget(null)}>
              Cancel
            </Button>
            <Button disabled={snoozePickerWake === null} onClick={submitSnoozePicker}>
              Snooze
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </MachineIdentityProvider>
  );
}
