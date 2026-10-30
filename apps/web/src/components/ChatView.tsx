import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  isUnoCreditsChoiceRequiredText,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { ACCOUNT_SWITCH_NOTE_BODY } from "@t3tools/shared/planLimitRules";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { truncate } from "@t3tools/shared/String";
import { isAssistantConversation } from "@t3tools/shared/assistantChat";
import { Debouncer } from "@tanstack/react-pacer";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  collapseExpandedComposerCursor,
  type ComposerSubmissionIntent,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveHtmlRenderEntries,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  withAttachedFiles,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadDetailLoaded } from "../threadDerivation";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useWindowInFront } from "../hooks/useWindowInFront";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { BranchToolbar } from "./BranchToolbar";
import { useDevMode } from "../devMode";
import {
  detectFileKind,
  isTabShown,
  makeTasksFile,
  NO_PROJECT_KEY,
  tasksTabId,
  useChatPanelContext,
  usePreviewPane,
  type PanelOpenSource,
} from "./preview/PreviewPaneContext";
import { clearThreadTasks, publishThreadTasks } from "./preview/tasksTabStore";
import { useChatPanelActionsStore } from "./preview/chatPanelActions";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { withAppShortcutDefaults } from "./appShortcuts.logic";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { BellIcon, ChevronDownIcon, ClockIcon, WifiOffIcon } from "lucide-react";
import { cn, randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { formatElapsedAgoLabel } from "../timestampFormat";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  replaceProjectScript,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import {
  getDefaultServerModel,
  getProviderModelCapabilities,
  isUsableDefaultProvider,
  resolveDefaultThreadProvider,
  resolveSelectableProvider,
} from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { useFolderChats } from "../hooks/useFolderChats";
import { openFolderForChat } from "../navigation/newProjectStore";
import type { ProjectUploadFile } from "../projectUpload";
import { saveFilesToUploads, stageChatFileUpload } from "../chatUploads";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type ComposerVideoAttachment,
  type DraftThreadEnvMode,
  finalizePromotedDraftThreadByRef,
  restorePromotingDraftThread,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { acceptsChatDrop } from "./chat/chatDrop";
import { useComposerFileHandoffStore } from "./computer/composerFileHandoffStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { recordingFrameAttachments } from "../screenRecording/frameAttachments";
import { appendRecordingToPrompt } from "../screenRecording/recordingLogic";
import { recordingReadiness } from "../screenRecording/pipeline";
import { useScreenRecordingStore } from "../screenRecording/recordingStore";
import { useComposerQuotesStore } from "../composerQuotesStore";
import { appendQuotesToPrompt, extractQuotes, quoteSummary } from "../lib/chatQuotes";
import { ReplySelectionToolbar } from "./chat/ReplySelectionToolbar";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  filterTimelineEntriesForVisibility,
  showsTimeline,
  type EmbeddedChatVisibility,
} from "./chat/embeddedChatVisibility";
import { ChatHeader } from "./chat/ChatHeader";
import { DraftHeroHeadline, DraftHeroStarters } from "./chat/DraftHeroHeadline";
import { ChatPlanLimitNotice, DraftPlanRoomNotice, PlanResumeLine } from "./chat/PlanRoomNotice";
import { unoSmartTarget } from "./chat/unoCreditsChoice.logic";
import {
  isPlanLimitText,
  pendingPlanResume,
  planProviderForDriver,
} from "../planRoom/planRoom.logic";
import { resolveDraftHeroState } from "./chat/draftHero.logic";
import { useDraftHeroLayoutTransition } from "./chat/useDraftHeroLayoutTransition";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { UnoBillingTopUpBanner } from "./chat/UnoBillingTopUpBanner";
import { CloudSleepsBanner } from "./assistants/PersonaMode";
import { AiBusyNotice } from "./chat/AiBusyNotice";
import { HarnessReauthCard } from "./chat/HarnessReauthCard";
import { resolveThreadHarnessAuthLoss, shouldReprobeProvider } from "./harness/harnessAuthLoss";
import { wasEverSignedIn } from "./harness/harnessSignInMemory";
import { refreshEnvironmentProviders } from "~/environments/settings/serverSettings";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { useReconnectWarningVisible } from "./chat/reconnectWarningGrace";
import { AssistantEngineBanner } from "./chat/AssistantEngine";
import { ThreadControlBar } from "./chat/ThreadControlBar";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  cloneComposerVideoForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { isConnectionShapedSendError, isEnvironmentLinkKnownDown } from "~/outbox/outboxFlusher";
import {
  isOutboxEligibleSend,
  selectOutboxEntriesForThread,
  useOutboxStore,
  type OutboxTurnStartCommand,
} from "~/outbox/outboxStore";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { pendingSendDecision, usePendingSendStore } from "./computer/pendingSendStore";
import { Button } from "./ui/button";
import { useSidebar } from "./ui/sidebar";
import { ChatMiniWindow } from "./chat/ChatMiniWindow";
import { FullscreenChatDockHeader, LegacyFocusChatPreview } from "./chat/FullscreenChatDock";
import { chatDockStatus, type ChatDockMode } from "./chat/chatDock.logic";
import { useChatDockInset } from "./chat/useChatDockInset";
import { useNotificationSoftAsk } from "../inbox/systemNotifications";
import { useDemoSwitch } from "~/demo/demoFlag";
import { useFeatureFlag } from "~/hooks/useFeatureFlags";
import {
  nextQueuedMessageToSend,
  shouldQueueSend,
  type QueuedChatMessage,
  useQueuedMessages,
  useQueuedMessageStore,
} from "../queuedMessageStore";
import { QueuedMessagesList } from "./chat/QueuedMessagesList";
import { selfUpdateBannerItem, useSelfUpdate } from "../selfUpdate/SelfUpdateNotice";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files or images without additional text. Respond using the conversation context and the attachment(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "reconnecting" | "disconnected" | "error";
  readonly lastSynchronizedAt: string | null;
};

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  return useStore(
    useMemo(() => {
      let previousThreadIds: readonly ThreadId[] = [];
      let previousResult: ThreadPlanCatalogEntry[] = [];
      let previousEntries = new Map<
        ThreadId,
        {
          shell: object | null;
          proposedPlanIds: readonly string[] | undefined;
          proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
          entry: ThreadPlanCatalogEntry;
        }
      >();

      return (state) => {
        const sameThreadIds =
          previousThreadIds.length === threadIds.length &&
          previousThreadIds.every((id, index) => id === threadIds[index]);
        const nextEntries = new Map<
          ThreadId,
          {
            shell: object | null;
            proposedPlanIds: readonly string[] | undefined;
            proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
            entry: ThreadPlanCatalogEntry;
          }
        >();
        const nextResult: ThreadPlanCatalogEntry[] = [];
        let changed = !sameThreadIds;

        for (const threadId of threadIds) {
          let shell: object | undefined;
          let proposedPlanIds: readonly string[] | undefined;
          let proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;

          for (const environmentState of Object.values(state.environmentStateById)) {
            const matchedShell = environmentState.threadShellById[threadId];
            if (!matchedShell) {
              continue;
            }
            shell = matchedShell;
            proposedPlanIds = environmentState.proposedPlanIdsByThreadId[threadId];
            proposedPlansById = environmentState.proposedPlanByThreadId[threadId] as
              | Record<string, Thread["proposedPlans"][number]>
              | undefined;
            break;
          }

          if (!shell) {
            const previous = previousEntries.get(threadId);
            if (
              previous &&
              previous.shell === null &&
              previous.proposedPlanIds === undefined &&
              previous.proposedPlansById === undefined
            ) {
              nextEntries.set(threadId, previous);
              continue;
            }
            changed = true;
            nextEntries.set(threadId, {
              shell: null,
              proposedPlanIds: undefined,
              proposedPlansById: undefined,
              entry: { id: threadId, proposedPlans: EMPTY_PROPOSED_PLANS },
            });
            continue;
          }

          const previous = previousEntries.get(threadId);
          if (
            previous &&
            previous.shell === shell &&
            previous.proposedPlanIds === proposedPlanIds &&
            previous.proposedPlansById === proposedPlansById
          ) {
            nextEntries.set(threadId, previous);
            nextResult.push(previous.entry);
            continue;
          }

          changed = true;
          const proposedPlans =
            proposedPlanIds && proposedPlanIds.length > 0 && proposedPlansById
              ? proposedPlanIds.flatMap((planId) => {
                  const proposedPlan = proposedPlansById?.[planId];
                  return proposedPlan ? [proposedPlan] : [];
                })
              : EMPTY_PROPOSED_PLANS;
          const entry = { id: threadId, proposedPlans };
          nextEntries.set(threadId, {
            shell,
            proposedPlanIds,
            proposedPlansById,
            entry,
          });
          nextResult.push(entry);
        }

        if (!changed && previousResult.length === nextResult.length) {
          return previousResult;
        }

        previousThreadIds = threadIds;
        previousEntries = nextEntries;
        previousResult = nextResult;
        return nextResult;
      };
    }, [threadIds]),
  );
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

/**
 * Встроенный режим (`EmbeddedThreadChat`): тот же чат, но без chrome главного
 * окна и без побочных эффектов, которые в одном документе должны быть в одном
 * экземпляре — глобальные горячие клавиши, контекст правой панели, терминалы,
 * общий ref композера. См. `EmbeddedThreadChat.tsx`.
 */
export interface ChatViewEmbeddedOptions {
  readonly visibility: EmbeddedChatVisibility;
  /** Показывать ли композер (ввод). */
  readonly composer: boolean;
}

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      embedded?: ChatViewEmbeddedOptions;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      embedded?: ChatViewEmbeddedOptions;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function isEditableOutsideComposer(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('[data-chat-composer-form="true"]')) return false;
  return element.isContentEditable || element.matches("input, textarea, select");
}

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
          }
          await api.terminal.close({
            threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeCloseTerminal, terminalState.terminalIds.length, threadId, threadRef],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalState.terminalHeight}
        terminalIds={terminalState.terminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onNewTerminal={createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    </div>
  );
});

export default function ChatView(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const embedded = props.embedded ?? null;
  const isEmbedded = embedded !== null;
  const embeddedVisibility: EmbeddedChatVisibility = embedded?.visibility ?? "full";
  const showComposer = embedded === null || embedded.composer;
  const devMode = useDevMode();
  const { open: sidebarOpen, openMobile, isMobile } = useSidebar();
  const sidebarVisible = isMobile ? openMobile : sidebarOpen;
  const sidebarHidden = isElectron && !sidebarVisible;
  const {
    openFile: openPreviewFile,
    openFileForTarget: openPreviewFileForTarget,
    closeFile: closePreviewFile,
    previewLayoutMode,
    open: previewOpen,
    files: previewFiles,
    activeFileId: previewActiveFileId,
    toggleOpen: togglePreviewOpen,
    setPreviewLayoutMode,
  } = usePreviewPane();
  // Встроенный чат сам живёт внутри правой панели — фокус-режим к нему не
  // применяется (иначе композер уехал бы в fixed-оверлей поверх приложения).
  const isPreviewFocusMode = previewLayoutMode === "focus" && !isEmbedded;
  // Labs `fullscreenChatDock` (w0138 p3). On: the chat is a dense block at the
  // bottom (peek / expanded) or folded into a mini window — or a narrow column
  // (demo switch). Off: the 0.0.137 "Latest step" pill above the composer.
  const fullscreenChatDock = useFeatureFlag("fullscreenChatDock");
  const isChatDockMode = isPreviewFocusMode && fullscreenChatDock;
  const [focusChatPanelMode, setFocusChatPanelMode] = useState<ChatDockMode>("peek");
  const chatDockVariant = useDemoSwitch("chatDock");
  const isFocusChatMinimized = isChatDockMode && focusChatPanelMode === "minimized";
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorByRef(routeKind === "server" ? routeThreadRef : null),
      [routeKind, routeThreadRef],
    ),
  );
  const setStoreThreadError = useStore((store) => store.setError);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const windowInFront = useWindowInFront();
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    routeKind === "server" ? store.threadLastVisitedAtById[routeThreadKey] : undefined,
  );
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerVideosRef = useRef<ComposerVideoAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const sharedComposerRef = useComposerHandleContext();
  // Общий ref композера принадлежит основному чату: встроенный экземпляр не
  // должен его перехватывать, иначе командная палитра и хоткеи начнут писать
  // в панель.
  const composerRef = isEmbedded ? localComposerRef : (sharedComposerRef ?? localComposerRef);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  // Вкладка задач открывается сама (настройка autoOpenPlanSidebar) один раз за
  // ход треда: закрыл человек вкладку — до следующего хода она не вернётся.
  const tasksTabAutoOpenedTurnByThreadRef = useRef(new Map<string, string>());
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalLaunchContext, setTerminalLaunchContext] = useState<TerminalLaunchContext | null>(
    null,
  );
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadKey).flatMap(([nextThreadKey, nextTerminalState]) =>
        nextTerminalState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const serverThreadKeys = useStore(
    useShallow((state) =>
      selectThreadsAcrossEnvironments(state).map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    ),
  );
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByThreadKey[scopedThreadKey(routeThreadRef)] ?? null,
  );
  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelectorByRef(fallbackDraftProjectRef), [fallbackDraftProjectRef]),
  );
  const localDraftError =
    routeKind === "server" && serverThread
      ? null
      : ((draftId ? localDraftErrorsByDraftId[draftId] : null) ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  // A server chat whose messages haven't come yet must not show "Send a
  // message to start the conversation." for a moment (S6 flicker recipe a).
  const serverThreadDetailLoaded = useStore((store) =>
    routeKind === "server"
      ? selectThreadDetailLoaded(selectEnvironmentState(store, environmentId), threadId)
      : true,
  );
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  // Plan mode is legacy (Settings → Legacy, upstream 48aa875c0e). Off, the
  // effective mode is "default" even for chats stored in plan mode, so nobody
  // is stuck in it with the switch hidden; the next send stores "default".
  const interactionMode = settings.planModeEnabled
    ? (composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE)
    : DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
  );
  // A folder or a .zip dropped on a new chat's box = the folder chip's "Upload
  // a folder…": once it's on the computer, this chat moves there with what was
  // typed. Other files stay attachments (ChatComposer decides on drop).
  const { moveDraftToFolder } = useFolderChats(activeThread?.environmentId ?? null);
  const hasDraftFolder = routeKind === "draft" && draftId !== null && activeProject !== undefined;
  const onDropFolder = useMemo(() => {
    if (!hasDraftFolder || draftId === null) return undefined;
    return (files: ReadonlyArray<ProjectUploadFile>) =>
      openFolderForChat(
        "upload",
        ({ folder, projectRef }) => moveDraftToFolder(draftId, folder, projectRef),
        files,
      );
  }, [draftId, hasDraftFolder, moveDraftToFolder]);

  useEffect(() => {
    if (routeKind !== "server") {
      return;
    }
    return retainThreadDetailSubscription(environmentId, threadId);
  }, [environmentId, routeKind, threadId]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const activeSavedEnvironmentRecord =
    activeThread && activeThread.environmentId !== primaryEnvironmentId
      ? (savedEnvironmentRegistry[activeThread.environmentId] ?? null)
      : null;
  const activeSavedEnvironmentRuntime = activeSavedEnvironmentRecord
    ? (savedEnvironmentRuntimeById[activeSavedEnvironmentRecord.environmentId] ?? null)
    : null;
  const activeSavedEnvironmentConnectionState = activeSavedEnvironmentRecord
    ? (activeSavedEnvironmentRuntime?.connectionState ?? "disconnected")
    : "connected";
  const activeEnvironmentUnavailable =
    activeSavedEnvironmentRecord !== null && activeSavedEnvironmentConnectionState !== "connected";
  const activeSavedEnvironmentId = activeSavedEnvironmentRecord?.environmentId ?? null;
  const activeEnvironmentUnavailableLabel = activeSavedEnvironmentRecord
    ? resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: activeSavedEnvironmentRecord.environmentId,
        runtimeLabel: activeSavedEnvironmentRuntime?.descriptor?.label ?? null,
        savedLabel: activeSavedEnvironmentRecord.label,
      })
    : null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (
      !activeEnvironmentUnavailable ||
      !activeEnvironmentUnavailableLabel ||
      !activeSavedEnvironmentId
    ) {
      return null;
    }

    return {
      environmentId: activeSavedEnvironmentId,
      label: activeEnvironmentUnavailableLabel,
      connectionState: activeSavedEnvironmentConnectionState,
      lastSynchronizedAt: activeSavedEnvironmentRuntime?.lastSynchronizedAt ?? null,
    };
  }, [
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeSavedEnvironmentConnectionState,
    activeSavedEnvironmentId,
    activeSavedEnvironmentRuntime?.lastSynchronizedAt,
  ]);
  // Messages written while the computer was unreachable (outbox/): shown in
  // the chat right away, delivered by the outbox flusher once it is back.
  const outboxEntriesForThread = useOutboxStore(
    useShallow((state) =>
      selectOutboxEntriesForThread(state.entries, activeThread?.environmentId, activeThread?.id),
    ),
  );
  const outboxChatMessages = useMemo<ChatMessage[]>(
    () =>
      outboxEntriesForThread.map((entry) => ({
        id: entry.command.message.messageId,
        role: "user",
        text: entry.command.message.text,
        createdAt: entry.command.createdAt,
        streaming: false,
      })),
    [outboxEntriesForThread],
  );
  const [reconnectingEnvironmentId, setReconnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId, label: string) => {
      setReconnectingEnvironmentId(environmentId);
      try {
        await reconnectSavedEnvironment(environmentId);
        toastManager.add({
          type: "success",
          title: "Machine reconnected",
          description: `${label} is ready.`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect machine",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      } finally {
        setReconnectingEnvironmentId(null);
      }
    },
    [],
  );
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const savedRecord = savedEnvironmentRegistry[p.environmentId];
      const runtimeState = savedEnvironmentRuntimeById[p.environmentId];
      const label = resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId: p.environmentId,
        runtimeLabel: runtimeState?.descriptor?.label ?? null,
        savedLabel: savedRecord?.label ?? null,
      });
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    allProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    // A chat left open while the person is in another app or away hasn't
    // been seen: it is marked when the window comes back in front.
    if (!windowInFront) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      activeLatestTurn.completedAt,
    );
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    windowInFront,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const primaryServerConfig = useServerConfig();
  const activeEnvRuntimeState = useSavedEnvironmentRuntimeStore((s) =>
    activeThread?.environmentId ? s.byId[activeThread.environmentId] : null,
  );
  // Use the server config for the thread's environment.  For the primary
  // environment fall back to the global atom; for remote environments use
  // the runtime state stored by the environment manager.
  const serverConfig =
    primaryEnvironmentId && activeThread?.environmentId === primaryEnvironmentId
      ? primaryServerConfig
      : (activeEnvRuntimeState?.serverConfig ?? primaryServerConfig);
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providerStatuses: serverConfig?.providers,
  });
  // Client/server version skew is a global notice now (StaleBundleNotice):
  // it offers the reload that actually fixes it, on every screen.
  // "A new version of Uno Work is ready · Update" for the computer this chat runs on.
  const selfUpdate = useSelfUpdate(activeThread?.environmentId ?? primaryEnvironmentId);
  const selfUpdateBanner = selfUpdateBannerItem(selfUpdate);
  const reconnectWarningVisible = useReconnectWarningVisible(activeEnvironmentUnavailableState);
  const environmentBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (activeEnvironmentUnavailableState && reconnectWarningVisible) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant:
          activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: (
          <>
            {activeEnvironmentUnavailableState.label} is{" "}
            {activeEnvironmentUnavailableState.connectionState === "connecting"
              ? "connecting"
              : activeEnvironmentUnavailableState.connectionState === "reconnecting"
                ? "reconnecting"
                : "disconnected"}
          </>
        ),
        description: activeEnvironmentUnavailableState.lastSynchronizedAt
          ? `Showing cached chats last synchronized ${formatElapsedAgoLabel(
              activeEnvironmentUnavailableState.lastSynchronizedAt,
            )}. Text messages you send now will go out when it is back.`
          : "Waiting for the first fresh chat snapshot. Text messages you send now will go out when it is back.",
        actions: (
          <>
            <Button
              size="xs"
              disabled={
                activeEnvironmentUnavailableState.connectionState === "connecting" ||
                activeEnvironmentUnavailableState.connectionState === "reconnecting" ||
                reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
              }
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                  activeEnvironmentUnavailableState.label,
                )
              }
            >
              {activeEnvironmentUnavailableState.connectionState === "connecting" ||
              activeEnvironmentUnavailableState.connectionState === "reconnecting" ||
              reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
                ? "Reconnecting..."
                : "Reconnect"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Connections
            </Button>
          </>
        ),
      });
    }
    const failedOutboxEntry = outboxEntriesForThread.find((entry) => entry.status === "failed");
    if (failedOutboxEntry) {
      items.push({
        id: `outbox-failed:${failedOutboxEntry.id}`,
        variant: "error",
        icon: <ClockIcon />,
        title: "A message written offline was not sent",
        description: failedOutboxEntry.error ?? undefined,
        actions: (
          <>
            <Button size="xs" onClick={() => useOutboxStore.getState().retry(failedOutboxEntry.id)}>
              Retry
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => useOutboxStore.getState().remove(failedOutboxEntry.id)}
            >
              Discard
            </Button>
          </>
        ),
      });
    }
    const queuedOutboxEntries = outboxEntriesForThread.filter((entry) => entry.status !== "failed");
    if (queuedOutboxEntries.length > 0) {
      const sending = queuedOutboxEntries.some((entry) => entry.status === "sending");
      const count = queuedOutboxEntries.length;
      items.push({
        id: "outbox-queued",
        variant: "info",
        icon: <ClockIcon />,
        title: sending
          ? `Sending ${count === 1 ? "your message" : `${count} messages`}…`
          : `${count === 1 ? "1 message" : `${count} messages`} waiting to send`,
        description: sending
          ? "Delivering what you wrote while offline."
          : `${count === 1 ? "It goes" : "They go"} out automatically when ${
              activeEnvironmentUnavailableState?.label ?? "the computer"
            } is back online.`,
        actions: (
          <Button
            size="xs"
            variant="outline"
            disabled={sending}
            onClick={() => {
              for (const entry of queuedOutboxEntries) {
                if (entry.status === "waiting") useOutboxStore.getState().remove(entry.id);
              }
            }}
          >
            Discard
          </Button>
        ),
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    navigate,
    outboxEntriesForThread,
    reconnectingEnvironmentId,
    reconnectWarningVisible,
  ]);
  // While Uno Work updates itself the daemon restarts: "can't reach the
  // computer" and "versions differ" would only repeat what the update notice says.
  const composerBannerItems =
    selfUpdate.view?.kind === "updating" && selfUpdateBanner
      ? [selfUpdateBanner]
      : selfUpdateBanner
        ? [...environmentBannerItems, selfUpdateBanner]
        : environmentBannerItems;
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  // An explicit picker selection is honored as before; a machine default
  // (thread/project seed, historically hardcoded codex) only sticks when that
  // harness can actually answer — a fresh Work box must land on the built-in
  // Uno gateway (or free OpenCode Zen), never on a logged-out Codex.
  const unlockedSelectedProvider = selectedProviderByThreadId
    ? resolveSelectableProvider(providerStatuses, selectedProviderByThreadId)
    : resolveDefaultThreadProvider(providerStatuses, threadProvider);
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  // План/задачи показываются вкладкой правой панели (не своей колонкой), см.
  // preview/tasksTabStore.ts. Кнопка в композере «нажата», пока вкладка на экране.
  const tasksTabThreadId = isEmbedded ? null : (activeThread?.id ?? null);
  const planSidebarOpen =
    tasksTabThreadId !== null &&
    isTabShown(
      { open: previewOpen, files: previewFiles, activeFileId: previewActiveFileId },
      tasksTabId(tasksTabThreadId),
    );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  // P5 (28.10): the browser's "Show notifications" window comes after a line
  // that says what for, at the moment it is useful — Uno works, the person may
  // switch tabs — not on the first click of the first screen.
  const notificationSoftAsk = useNotificationSoftAsk(isWorking && !isEmbedded);
  const notificationSoftAskBanner: ComposerBannerStackItem | null = notificationSoftAsk.visible
    ? {
        id: "notifications-soft-ask",
        variant: "info",
        icon: <BellIcon />,
        title: "Get a ping when Uno needs you",
        description:
          "Uno keeps working while you're in another tab. Turn on notifications to hear when it asks you something or finishes — your browser will ask to allow them.",
        actions: (
          <>
            <Button size="xs" variant="ghost" onClick={notificationSoftAsk.notNow}>
              Not now
            </Button>
            <Button size="xs" onClick={() => void notificationSoftAsk.turnOn()}>
              Turn on
            </Button>
          </>
        ),
      }
    : null;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  useEffect(() => {
    if (typeof Image === "undefined" || !serverMessages || serverMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = serverMessages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, serverMessages]);
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0 && outboxChatMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const shownIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages: ChatMessage[] = [];
    for (const message of [...optimisticUserMessages, ...outboxChatMessages]) {
      if (shownIds.has(message.id)) continue;
      shownIds.add(message.id);
      pendingMessages.push(message);
    }
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    serverMessages,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
    outboxChatMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        deriveHtmlRenderEntries(threadActivities),
      ),
    [activeThread?.proposedPlans, threadActivities, timelineMessages, workLogEntries],
  );
  // Фильтр видимости встроенного чата: применяем на выборке строк, а не в
  // рендере — плагин не может ни добавить строку, ни расширить права.
  const visibleTimelineEntries = useMemo(
    () => filterTimelineEntriesForVisibility(timelineEntries, embeddedVisibility),
    [embeddedVisibility, timelineEntries],
  );
  // A new chat not sent yet: the composer in the middle under "What should we
  // do in [folder] on [computer]?" (upstream draft hero, #4055).
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread: routeKind === "draft" && draftId !== null && isLocalDraftThread,
    hasTimelineEntries: visibleTimelineEntries.length > 0,
    isWorking,
    isEmbedded,
    isPreviewFocusMode,
    isAssistantConversation: activeThread ? isAssistantConversation(activeThread) : false,
    showComposer,
  });
  const draftHeroTransitionGroupRef = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  const previewProjectKey = useMemo(
    () =>
      activeProject
        ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
        : null,
    [activeProject, projectGroupingSettings],
  );
  // Контекст правой панели проставляет ТОЛЬКО основной чат: встроенный
  // экземпляр живёт внутри этой самой панели и затёр бы проект вкладки.
  useChatPanelContext(
    isEmbedded
      ? null
      : {
          projectKey: previewProjectKey,
          projectCwd: activeProject?.cwd ?? null,
          projectId: activeProject?.id ?? null,
          environmentId,
          threadId: activeThread?.id ?? null,
        },
  );
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  // Escape hatch for the status banner: when the active harness is unusable
  // because it is not signed in (the fresh-Work-box "run codex login" dead
  // end), offer a one-click switch to the built-in Uno gateway if it is live.
  const unoProviderFallbackTarget = useMemo(() => {
    if (!activeProviderStatus) return null;
    if (activeProviderStatus.status === "ready" || activeProviderStatus.status === "disabled") {
      return null;
    }
    if (activeProviderStatus.driver === "uno") return null;
    if (activeProviderStatus.auth.status === "authenticated") return null;
    const uno = providerStatuses.find(
      (candidate) => candidate.driver === "uno" && isUsableDefaultProvider(candidate),
    );
    if (!uno) return null;
    return {
      instanceId: uno.instanceId,
      model: getDefaultServerModel(providerStatuses, uno.driver),
    };
  }, [activeProviderStatus, providerStatuses]);
  // A harness that lost its sign-in gets the in-chat "You were signed out"
  // card instead of the red banners. Assistant chats are always Hermes.
  const harnessAuth = useMemo(
    () =>
      activeThread
        ? resolveThreadHarnessAuthLoss({
            thread: activeThread,
            providerStatuses,
            activeProviderStatus,
            // Never signed in here: "Sign in to Claude", not "You were signed out".
            everSignedIn: wasEverSignedIn,
          })
        : null,
    [activeThread, activeProviderStatus, providerStatuses],
  );
  // A turn failed on an auth error but the snapshot still says signed in:
  // ask the daemon to re-probe once, so the picker badge catches up.
  const reprobedAuthErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const status = harnessAuth?.providerStatus ?? null;
    if (!harnessAuth || !status || !shouldReprobeProvider(harnessAuth.loss, status)) return;
    const key = `${activeThread?.id}:${status.instanceId}:${activeThread?.session?.updatedAt ?? activeThread?.error ?? ""}`;
    if (reprobedAuthErrorRef.current === key) return;
    reprobedAuthErrorRef.current = key;
    void refreshEnvironmentProviders(environmentId, status.instanceId).catch(() => {
      // Best effort: the daemon re-probes on its own schedule anyway.
    });
  }, [
    activeThread?.error,
    activeThread?.id,
    activeThread?.session?.updatedAt,
    environmentId,
    harnessAuth,
  ]);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalLaunchContext?.threadId === activeThreadId
      ? terminalLaunchContext
      : (storeServerTerminalLaunchContext ?? null);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const panelToggleShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "rightPanel.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, environmentId, isServerThread, navigate, onDiffPanelOpen, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const isCurrentServerThread = shouldWriteThreadErrorToCurrentServerThread({
        serverThread,
        routeThreadRef,
        targetThreadId,
      });
      if (isCurrentServerThread) {
        setStoreThreadError(targetThreadId, nextError);
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextError,
        };
      });
    },
    [draftId, routeThreadRef, serverThread, setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback((selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  }, []);
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadRef, setTerminalOpen, terminalState.terminalOpen]);
  // The right panel's launcher opens this chat's terminal drawer and Changes
  // (they are not panel tabs). Only the main chat publishes them; a tile that
  // makes no sense here (no project, not git) gets null and is not shown.
  const publishChatPanelActions = useChatPanelActionsStore((store) => store.publish);
  const withdrawChatPanelActions = useChatPanelActionsStore((store) => store.withdraw);
  const panelActionsThreadId = isEmbedded ? null : (activeThread?.id ?? null);
  const terminalAvailable = activeProject !== undefined;
  const changesAvailable = isServerThread && isGitRepo;
  useEffect(() => {
    if (panelActionsThreadId === null) return;
    publishChatPanelActions({
      threadId: panelActionsThreadId,
      openTerminal: terminalAvailable ? () => setTerminalOpen(true) : null,
      openChanges: changesAvailable
        ? () => {
            if (!diffOpen) onToggleDiff();
          }
        : null,
    });
  }, [
    changesAvailable,
    diffOpen,
    onToggleDiff,
    panelActionsThreadId,
    publishChatPanelActions,
    setTerminalOpen,
    terminalAvailable,
  ]);
  useEffect(() => {
    if (panelActionsThreadId === null) return;
    return () => withdrawChatPanelActions(panelActionsThreadId);
  }, [panelActionsThreadId, withdrawChatPanelActions]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadRef || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, storeNewTerminal]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      if (activeThreadRef) {
        storeCloseTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      environmentId,
      storeCloseTerminal,
      terminalState.terminalIds.length,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        const localApi = readLocalApi();
        if (!localApi) {
          throw new Error("Local API unavailable.");
        }
        await localApi.server.upsertKeybinding(keybindingRule);
      }
    },
    [environmentId],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        runOnSettle: input.runOnSettle,
      };
      const nextScripts = replaceProjectScript(activeProject.scripts, nextScript);

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        runOnSettle: input.runOnSettle,
      };
      const nextScripts = replaceProjectScript(activeProject.scripts, updatedScript);

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const openTasksTab = useCallback(
    (threadId: ThreadId, source: PanelOpenSource, label: string) => {
      openPreviewFileForTarget(
        { projectKey: previewProjectKey ?? NO_PROJECT_KEY, threadId },
        "chat",
        makeTasksFile({ threadId, environmentId, label }),
        source,
      );
    },
    [environmentId, openPreviewFileForTarget, previewProjectKey],
  );
  const togglePlanSidebar = useCallback(() => {
    if (!tasksTabThreadId) return;
    if (planSidebarOpen) {
      closePreviewFile(tasksTabId(tasksTabThreadId));
      return;
    }
    openTasksTab(tasksTabThreadId, "person", planSidebarLabel);
  }, [closePreviewFile, openTasksTab, planSidebarLabel, planSidebarOpen, tasksTabThreadId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.instanceId !== serverThread.modelSelection.instanceId ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [environmentId, serverThread],
  );

  // Scroll helpers — LegendList handles auto-scroll via maintainScrollAtEnd.
  const scrollToEnd = useCallback((animated = false) => {
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches.  LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, [activeThread?.id]);

  // Вкладка задач в правой панели читает план отсюда: панель живёт вне ChatView.
  useEffect(() => {
    if (!tasksTabThreadId) return;
    publishThreadTasks(tasksTabThreadId, {
      activePlan,
      proposedPlan: sidebarProposedPlan,
      label: planSidebarLabel,
      environmentId,
      markdownCwd: gitCwd ?? undefined,
      workspaceRoot: activeWorkspaceRoot,
    });
  }, [
    activePlan,
    activeWorkspaceRoot,
    environmentId,
    gitCwd,
    planSidebarLabel,
    sidebarProposedPlan,
    tasksTabThreadId,
  ]);
  useEffect(() => {
    if (!tasksTabThreadId) return;
    return () => clearThreadTasks(tasksTabThreadId);
  }, [tasksTabThreadId]);

  // Auto-open the tasks tab when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  // Source "agent": a panel the person closed in this chat stays closed (the tab
  // is added and the panel button gets a badge).
  const tasksTabPresent =
    tasksTabThreadId !== null &&
    previewFiles.some((file) => file.id === tasksTabId(tasksTabThreadId));
  useEffect(() => {
    if (!autoOpenPlanSidebar || !tasksTabThreadId) return;
    if (!activePlan) return;
    // Diff и правая панель взаимоисключающие: открытая панель закрыла бы diff,
    // который человек смотрит. Откроем вкладку, когда diff закроют.
    if (diffOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? "__no_turn__";
    const autoOpened = tasksTabAutoOpenedTurnByThreadRef.current;
    if (autoOpened.get(tasksTabThreadId) === turnKey) return;
    autoOpened.set(tasksTabThreadId, turnKey);
    if (tasksTabPresent) return;
    openTasksTab(tasksTabThreadId, "agent", planSidebarLabel);
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    autoOpenPlanSidebar,
    diffOpen,
    openTasksTab,
    planSidebarLabel,
    sidebarProposedPlan?.turnId,
    tasksTabPresent,
    tasksTabThreadId,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    // Встроенный чат не забирает фокус: пользователь мог открыть панель, но
    // печатать в основном чате.
    if (isEmbedded) return;
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isEmbedded, terminalState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(routeThreadRef);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId, routeThreadRef, storeClearTerminalLaunchContext]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        if (activeThreadRef) {
          storeClearTerminalLaunchContext(activeThreadRef);
        }
        return null;
      }
      return current;
    });
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd || !storeServerTerminalLaunchContext) {
      return;
    }
    const settledCwd = projectScriptCwd({
      project: { cwd: activeProjectCwd },
      worktreePath: activeThreadWorktreePath,
    });
    if (
      settledCwd === storeServerTerminalLaunchContext.cwd &&
      (activeThreadWorktreePath ?? null) === storeServerTerminalLaunchContext.worktreePath
    ) {
      if (activeThreadRef) {
        storeClearTerminalLaunchContext(activeThreadRef);
      }
    }
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    if (activeThreadRef) {
      storeClearTerminalLaunchContext(activeThreadRef);
    }
    setTerminalLaunchContext((current) => (current?.threadId === activeThreadId ? null : current));
  }, [
    activeThreadId,
    activeThreadRef,
    storeClearTerminalLaunchContext,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalState.terminalOpen]);

  // Files or a chat dropped anywhere in the window land in this chat's box,
  // unless something under the pointer took them (the box, a sidebar chat, Files).
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState(false);
  useEffect(() => {
    if (isEmbedded) return;
    let depth = 0;
    const accepts = (event: DragEvent) =>
      event.dataTransfer !== null && acceptsChatDrop(event.dataTransfer);
    const onDragEnter = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth += 1;
      setIsDraggingOverWindow(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDraggingOverWindow(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!accepts(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setIsDraggingOverWindow(false);
      if (!accepts(event) || event.defaultPrevented || !event.dataTransfer) return;
      event.preventDefault();
      composerRef.current?.acceptTransfer(event.dataTransfer);
    };
    const onDragEnd = () => {
      depth = 0;
      setIsDraggingOverWindow(false);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [isEmbedded]);

  useEffect(() => {
    // Глобальные хоткеи чата вешает только основной экземпляр — иначе открытая
    // панель со встроенным чатом обрабатывала бы каждое сочетание дважды.
    if (isEmbedded) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || useCommandPaletteStore.getState().open || event.defaultPrevented) {
        return;
      }
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      const command = resolveShortcutCommand(event, withAppShortcutDefaults(keybindings), {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        togglePreviewOpen();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      if (command === "composer.stash") {
        // ⌘S in another text field (a file open in the panel) is that field's.
        const focused = document.activeElement;
        if (isEditableOutsideComposer(focused)) return;
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.setAside();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    isEmbedded,
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    togglePreviewOpen,
    toggleTerminalVisibility,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (!api || !localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before going back to a snapshot.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Stop the current step before going back to a snapshot.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Go back to snapshot ${turnCount}?`,
          "This will discard the newer messages and their changes in this chat.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to go back to that snapshot.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      setThreadError,
    ],
  );

  /**
   * `queued`: a message from "Up next" (queuedMessageStore.ts) goes instead of
   * the composer's content — the composer, whatever is typed in it now, stays.
   */
  const onSend = async (
    e?: { preventDefault: () => void },
    queued?: QueuedChatMessage,
    intent: ComposerSubmissionIntent = "foreground",
  ) => {
    e?.preventDefault();
    const inBackground = intent === "background" && !queued;
    // A queued message that can't go now is not lost: back first, held.
    const keepQueued = () => {
      if (queued) useQueuedMessageStore.getState().holdAtFront(routeThreadKey, queued);
    };
    const api = readEnvironmentApi(environmentId);
    if (!activeThread || isSendBusy || isConnecting || sendInFlightRef.current) {
      keepQueued();
      return;
    }
    // Offline: a plain message to an existing chat goes to the outbox (below);
    // everything else still needs the link.
    const linkDown =
      !api || activeEnvironmentUnavailable || isEnvironmentLinkKnownDown(environmentId);
    // An "Up next" message never goes to the outbox: it stays first in the
    // queue (held, Send now) - one message is in one place only.
    if (linkDown && queued) {
      keepQueued();
      return;
    }
    if (linkDown && !isServerThread) return;
    const offlineLabel = activeEnvironmentUnavailableLabel ?? "the computer";
    if (linkDown && activePendingProgress) {
      setThreadError(activeThread.id, `Answer once ${offlineLabel} is back online.`);
      return;
    }
    if (activePendingProgress && !queued) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) {
      keepQueued();
      return;
    }
    const {
      images: ctxComposerImages,
      videos: ctxComposerVideos,
      files: ctxComposerFiles,
      terminalContexts: ctxComposerTerminalContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      imageSupport: ctxImageSupport,
    } = sendCtx;
    // A queued message is text only: nothing of the composer goes with it.
    const composerImages = queued ? [] : ctxComposerImages;
    const composerVideos = queued ? [] : ctxComposerVideos;
    const composerFiles = queued ? [] : ctxComposerFiles;
    const composerTerminalContexts = queued ? [] : ctxComposerTerminalContexts;
    const promptForSend = queued ? queued.text : promptRef.current;
    // Loom Work: the chat's screen recording goes with the message as a block.
    const composerRecording = queued
      ? null
      : (useScreenRecordingStore.getState().items[activeThread.id] ?? null);
    // Quotes with a remark: they go as a block of the message's text.
    const composerQuotes = queued
      ? []
      : (useComposerQuotesStore.getState().items[activeThread.id] ?? []);
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount:
        composerImages.length +
        composerVideos.length +
        composerFiles.length +
        composerQuotes.length +
        (composerRecording ? 1 : 0),
      terminalContexts: composerTerminalContexts,
    });
    const hasComposerAttachments =
      composerImages.length > 0 ||
      composerVideos.length > 0 ||
      composerFiles.length > 0 ||
      composerRecording !== null;
    if (
      !queued &&
      !linkDown &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      !hasComposerAttachments &&
      composerQuotes.length === 0 &&
      sendableComposerTerminalContexts.length === 0
    ) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      !queued &&
      !hasComposerAttachments &&
      composerQuotes.length === 0 &&
      sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    // /plan and /default act only with legacy plan mode on; else plain text.
    if (standaloneSlashCommand && settings.planModeEnabled) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (composerRecording) {
      const readiness = recordingReadiness(composerRecording);
      if (!readiness.ready) {
        setThreadError(activeThread.id, readiness.blocking);
        return;
      }
    }
    const pendingVideo = composerVideos.find(
      (video) => video.status !== "ready" || !video.digestId || !video.jobId || !video.digest,
    );
    if (pendingVideo) {
      setThreadError(
        activeThread.id,
        pendingVideo.status === "failed"
          ? `Video '${pendingVideo.name}' failed. Retry or remove it before sending.`
          : `Wait until video '${pendingVideo.name}' finishes processing before sending.`,
      );
      return;
    }
    // Enter while the agent works: the message waits in "Up next" and goes
    // by itself when the agent is done — it no longer cuts into the running
    // turn (that is "Send now"). Pictures, files, a recording or terminal
    // context still go at once: the queue keeps text only. Offline the
    // message goes to the outbox instead (below), never to both.
    if (
      !queued &&
      shouldQueueSend({
        agentWorking: phase === "running",
        linkDown,
        hasAttachments: hasComposerAttachments || sendableComposerTerminalContexts.length > 0,
        // Leaving the chat: "Up next" only moves while the chat is on screen.
        sendNow: inBackground,
      })
    ) {
      useQueuedMessageStore
        .getState()
        .enqueue(routeThreadKey, appendQuotesToPrompt(promptForSend.trim(), composerQuotes));
      useComposerQuotesStore.getState().take(activeThread.id);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!activeProject) {
      keepQueued();
      return;
    }
    const threadIdForSend = activeThread.id;
    const projectRefForNextChat = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const nextChatOptions = {
      envMode: sendEnvMode,
      branch: activeThreadBranch,
      worktreePath: sendEnvMode === "worktree" ? null : activeThread.worktreePath,
      runtimeMode,
    };
    const startNextChat = () =>
      handleNewThread(projectRefForNextChat, nextChatOptions).catch(() => {
        toastManager.add(
          stackedThreadToast({ type: "warning", title: "Couldn't open a new chat" }),
        );
      });
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(
        threadIdForSend,
        "Select a base branch before sending in “separate copy” mode.",
      );
      return;
    }

    const outboxEligible = isOutboxEligibleSend({
      isServerThread,
      hasAttachments: hasComposerAttachments,
      needsBootstrap: isLocalDraftThread || shouldCreateWorktree,
    });
    if (linkDown) {
      if (!outboxEligible) {
        setThreadError(
          threadIdForSend,
          `${offlineLabel} is offline. Messages with attachments can be sent once it is back.`,
        );
        return;
      }
      const queuedTitleSeed =
        trimmed ||
        (composerQuotes[0] ? quoteSummary(composerQuotes[0]) : "") ||
        (sendableComposerTerminalContexts[0]
          ? formatTerminalContextLabel(sendableComposerTerminalContexts[0])
          : "New chat");
      useOutboxStore.getState().enqueue({
        environmentId,
        command: {
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: formatOutgoingPrompt({
              provider: ctxSelectedProvider,
              model: ctxSelectedModel,
              models: ctxSelectedProviderModels,
              effort: ctxSelectedPromptEffort,
              text: appendTerminalContextsToPrompt(
                appendQuotesToPrompt(promptForSend, composerQuotes),
                sendableComposerTerminalContexts,
              ),
            }),
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: truncate(queuedTitleSeed),
          runtimeMode,
          interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      isAtEndRef.current = true;
      setThreadError(threadIdForSend, null);
      useComposerQuotesStore.getState().take(activeThread.id);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      if (inBackground) void startNextChat();
      return;
    }
    if (!api) return;

    // A new chat sent in the background leaves the screen right away: this
    // view is the next chat's by the time the send finishes. An open chat
    // goes on to the next one once the computer has the message.
    const backgroundDraftId = inBackground && isLocalDraftThread ? (draftId ?? null) : null;
    sendInFlightRef.current = true;
    if (!backgroundDraftId) {
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    }

    const composerImagesSnapshot = [...composerImages];
    const composerVideosSnapshot = [...composerVideos];
    const composerFilesSnapshot = [...composerFiles];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const takenRecording = composerRecording
      ? useScreenRecordingStore.getState().take(activeThread.id)
      : null;
    // Loom Work: the key frames go as pictures — when the model takes them.
    const recordingFrames =
      takenRecording && ctxImageSupport !== "unsupported"
        ? recordingFrameAttachments(takenRecording.item)
        : [];
    const recordingForAgent = takenRecording
      ? recordingFrames.length > 0
        ? takenRecording.forAgent
        : { ...takenRecording.forAgent, frames: [] }
      : null;
    const takenQuotes = queued ? [] : useComposerQuotesStore.getState().take(activeThread.id);
    const messageTextForSend = appendTerminalContextsToPrompt(
      appendRecordingToPrompt(appendQuotesToPrompt(promptForSend, takenQuotes), recordingForAgent),
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all([
      ...composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
      ...recordingFrames.map(async (frame) => ({
        type: "image" as const,
        name: frame.name,
        mimeType: "image/jpeg",
        sizeBytes: frame.blob.size,
        dataUrl: await readFileAsDataUrl(frame.blob),
      })),
      ...composerVideosSnapshot.map(async (video) => ({
        type: "video_digest" as const,
        digestId: video.digestId!,
        jobId: video.jobId!,
        name: video.name,
      })),
      // Staged on the chat's computer; the server files them in ~/Uploads.
      ...composerFilesSnapshot.map((file) => stageChatFileUpload(environmentId, file)),
    ]);
    const optimisticImageAttachments = [
      ...composerImagesSnapshot.map((image) => ({
        type: "image" as const,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.previewUrl,
      })),
      ...recordingFrames.map((frame) => ({
        type: "image" as const,
        id: frame.id,
        name: frame.name,
        mimeType: "image/jpeg",
        sizeBytes: frame.blob.size,
        previewUrl: frame.previewUrl,
      })),
    ];
    const optimisticVideoAttachments = composerVideosSnapshot.map((video) => ({
      type: "video_digest" as const,
      id: video.id,
      name: video.name,
      sourceMimeType: video.digest!.source.mimeType,
      sourceSizeBytes: video.digest!.source.sizeBytes,
      durationMs: video.digest!.source.durationMs,
      digestId: video.digestId!,
      jobId: video.jobId!,
      frameCount: video.digest!.frames.length,
      transcriptSegmentCount: video.digest!.transcript.segments.length,
      posterPreviewUrl: video.previewUrl,
    }));
    const optimisticFileAttachments = composerFilesSnapshot.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      path: "",
    }));
    const optimisticAttachments = [
      ...optimisticImageAttachments,
      ...optimisticVideoAttachments,
      ...optimisticFileAttachments,
    ];
    // Scroll to the current end *before* adding the optimistic message.
    // This sets LegendList's internal isAtEnd=true so maintainScrollAtEnd
    // automatically pins to the new item when the data changes.
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    await legendListRef.current?.scrollToEnd?.({ animated: false });

    if (!backgroundDraftId) {
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
    }

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    if (!queued) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.clearVideoAttachments();
      composerRef.current?.setFileAttachments([]);
      composerRef.current?.resetCursorState();
    }

    if (backgroundDraftId) {
      // The draft stays until the server has the chat; its project is free
      // for the next one. The next message can go right away.
      useComposerDraftStore
        .getState()
        .markDraftThreadPromoting(
          backgroundDraftId,
          scopeThreadRef(environmentId, threadIdForSend),
        );
      await startNextChat();
      sendInFlightRef.current = false;
    }

    let turnStartSucceeded = false;
    const turnCommandId = newCommandId();
    // Text-only send to an existing chat: if the link drops under it, it goes
    // to the outbox with this same command (same commandId: no double send).
    let outboxFallbackCommand: OutboxTurnStartCommand | null = null;
    await (async () => {
      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let firstComposerVideoName: string | null = null;
      if (composerVideosSnapshot.length > 0) {
        const firstComposerVideo = composerVideosSnapshot[0];
        if (firstComposerVideo) {
          firstComposerVideoName = firstComposerVideo.name;
        }
      }
      let titleSeed = trimmed || (takenQuotes[0] ? quoteSummary(takenQuotes[0]) : "");
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (firstComposerVideoName) {
          titleSeed = `Video: ${firstComposerVideoName}`;
        } else if (composerFilesSnapshot[0]) {
          titleSeed = `File: ${composerFilesSnapshot[0].name}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = "New chat";
        }
      }
      const title = truncate(titleSeed);
      if (outboxEligible) {
        outboxFallbackCommand = {
          type: "thread.turn.start",
          commandId: turnCommandId,
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          createdAt: messageCreatedAt,
        };
      }
      const threadCreateModelSelection = createModelSelection(
        ctxSelectedModelSelection.instanceId,
        ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
        ctxSelectedModelSelection.options,
      );

      // Auto-title from first message. Not the pinned Uno chat: it is shown as
      // "Uno" whatever its title, and this awaited round trip sat right in
      // front of its first turn.
      if (isFirstMessage && isServerThread && activeThread.assistantRole !== "chat") {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.cwd,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      if (!backgroundDraftId) beginLocalDispatch({ preparingWorktree: false });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: turnCommandId,
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: ctxSelectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (backgroundDraftId) {
        // Nothing reached the computer: the draft comes back whole, reachable
        // from the toast, and the chat on screen isn't touched.
        restorePromotingDraftThread(backgroundDraftId);
        setComposerDraftPrompt(backgroundDraftId, promptForSend);
        addComposerDraftImages(
          backgroundDraftId,
          composerImagesSnapshot.map(cloneComposerImageForRetry),
        );
        useComposerFileHandoffStore.getState().handOff(backgroundDraftId, composerFilesSnapshot);
        useComposerQuotesStore.getState().restore(threadIdForSend, takenQuotes);
        setComposerDraftTerminalContexts(backgroundDraftId, composerTerminalContextsSnapshot);
        if (takenRecording) useScreenRecordingStore.getState().restore(takenRecording.item);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "The task didn't start",
            description: err instanceof Error ? err.message : "Failed to send message.",
            actionProps: {
              children: "Open draft",
              onClick: () => {
                void navigate({ to: "/draft/$draftId", params: { draftId: backgroundDraftId } });
              },
            },
          }),
        );
        return;
      }
      if (!turnStartSucceeded && outboxFallbackCommand && isConnectionShapedSendError(err)) {
        // The link dropped under the send (queued or typed): the outbox
        // delivers this same command (same commandId) once it is back.
        useOutboxStore.getState().enqueue({ environmentId, command: outboxFallbackCommand });
        setOptimisticUserMessages((existing) => {
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        setThreadError(threadIdForSend, null);
        return;
      }
      if (queued && !turnStartSucceeded) {
        // It goes back first in "Up next", waiting for Send now.
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        useQueuedMessageStore.getState().holdAtFront(routeThreadKey, queued);
      } else if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerVideosRef.current.length === 0 &&
        (composerRef.current?.getSendContext().files.length ?? 0) === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        const retryComposerVideos = composerVideosSnapshot.map(cloneComposerVideoForRetry);
        composerImagesRef.current = retryComposerImages;
        composerVideosRef.current = retryComposerVideos;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        composerRef.current?.setVideoAttachments(retryComposerVideos);
        composerRef.current?.setFileAttachments(composerFilesSnapshot);
        if (takenRecording) useScreenRecordingStore.getState().restore(takenRecording.item);
        useComposerQuotesStore.getState().restore(activeThread.id, takenQuotes);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    if (backgroundDraftId) {
      if (turnStartSucceeded) {
        const startedRef = scopeThreadRef(environmentId, threadIdForSend);
        finalizePromotedDraftThreadByRef(startedRef);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Started in the background",
            timeout: 5_000,
            actionProps: {
              children: "Open",
              onClick: () => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(startedRef),
                });
              },
            },
          }),
        );
      }
      return;
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
    if (inBackground && turnStartSucceeded) await startNextChat();
  };

  // Home's composer opened this chat with a task typed in and asked it to send
  // it: do exactly what Enter would, once the chat is ready (see pendingSendStore).
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onComposerSend = useCallback(
    (e?: { preventDefault: () => void }, intent?: ComposerSubmissionIntent) =>
      void onSendRef.current(e, undefined, intent),
    [],
  );

  // "Up next" (S4, upstream cc839c42b1): the first waiting message goes by
  // itself once the agent is done and nothing else needs the person.
  const queuedMessages = useQueuedMessages(routeThreadKey);
  const [messagesViewport, setMessagesViewport] = useState<HTMLDivElement | null>(null);
  const nextQueued = nextQueuedMessageToSend({
    queue: queuedMessages,
    phase,
    busy: isSendBusy || isConnecting || activeEnvironmentUnavailable,
    waitingForPerson: activePendingApproval !== null || pendingUserInputs.length > 0,
    hasError: Boolean(activeThread?.error),
  });
  useEffect(() => {
    if (!nextQueued || sendInFlightRef.current) return;
    const taken = useQueuedMessageStore.getState().take(routeThreadKey, nextQueued.id);
    if (taken) void onSendRef.current(undefined, taken);
  }, [nextQueued, routeThreadKey]);
  const onSendQueuedNow = useCallback(
    (id: string) => {
      // "Send now": into the running turn, as Enter used to do.
      if (sendInFlightRef.current) return;
      const taken = useQueuedMessageStore.getState().take(routeThreadKey, id);
      if (taken) void onSendRef.current(undefined, taken);
    },
    [routeThreadKey],
  );
  const onEditQueued = useCallback(
    (id: string) => {
      const taken = useQueuedMessageStore.getState().take(routeThreadKey, id);
      if (!taken) return;
      // Back into the composer, after whatever is typed there now.
      const { text: takenText, quotes } = extractQuotes(taken.text);
      if (activeThread && quotes.length > 0) {
        useComposerQuotesStore.getState().restore(activeThread.id, quotes);
      }
      const nextPrompt = [promptRef.current.trim(), takenText].filter(Boolean).join("\n\n");
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
        prompt: nextPrompt,
        detectTrigger: false,
      });
    },
    [activeThread, composerDraftTarget, routeThreadKey, setComposerDraftPrompt],
  );
  const onDeleteQueued = useCallback(
    (id: string) => {
      useQueuedMessageStore.getState().take(routeThreadKey, id);
    },
    [routeThreadKey],
  );
  const pendingSend = usePendingSendStore((store) => store.pending);
  const [, setPendingSendTick] = useState(0);
  useEffect(() => {
    const decision = pendingSendDecision(pendingSend, {
      draftId,
      composerPrompt: promptRef.current,
      ready:
        activeThread != null &&
        activeProject != null &&
        !isSendBusy &&
        !isConnecting &&
        !activeEnvironmentUnavailable &&
        !sendInFlightRef.current &&
        composerRef.current?.getSendContext() != null,
      now: Date.now(),
    });
    if (decision === "ignore") return;
    if (decision === "wait") {
      const timer = setTimeout(() => setPendingSendTick((tick) => tick + 1), 250);
      return () => clearTimeout(timer);
    }
    usePendingSendStore.getState().clear();
    if (decision === "send") void onSendRef.current();
  });

  const onInterrupt = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    // Stop means "I take over": what waits in Up next waits for Send now.
    useQueuedMessageStore.getState().holdAll(routeThreadKey);
    const activeTurnId =
      activeThread.session?.activeTurnId ?? activeLatestTurn?.turnId ?? undefined;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      let answersToSend = answers;
      const answerFiles = composerRef.current?.getAnswerFiles() ?? [];
      if (answerFiles.length > 0) {
        try {
          answersToSend = withAttachedFiles(
            answers,
            await saveFilesToUploads(environmentId, answerFiles),
          );
        } catch (err) {
          // Nothing went: the answer and its files stay, ready to try again.
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Couldn't upload the files.",
          );
          setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
          return;
        }
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers: answersToSend,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  // A typed value, "Skip" or a connected app answers the question at once
  // (an assistant setting itself up asks one at a time, 16.10).
  const onAnswerActivePendingUserInput = useCallback(
    (questionId: string, answer: string) => {
      if (!activePendingUserInput) return;
      const others = activePendingResolvedAnswers ?? {};
      void onRespondToUserInput(activePendingUserInput.requestId, {
        ...others,
        [questionId]: answer,
      });
    },
    [activePendingResolvedAnswers, activePendingUserInput, onRespondToUserInput],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Scroll to the current end *before* adding the optimistic message.
      isAtEndRef.current = true;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      await legendListRef.current?.scrollToEnd?.({ animated: false });

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: ctxSelectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default" && autoOpenPlanSidebar && !isEmbedded) {
          openTasksTab(threadIdForSend, "person", "Tasks");
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      autoOpenPlanSidebar,
      environmentId,
      isEmbedded,
      openTasksTab,
    ],
  );

  // "Signed in. Retry" on the re-auth card: send the thread's last user
  // message again as a new turn. Text only — the failed turn's attachments
  // are not re-uploaded (their files live in the old message; re-sending them
  // would mean re-reading blobs we don't keep client-side).
  const lastUserMessageText = useMemo(() => {
    const messages = activeThread?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "user" && message.text.trim().length > 0) return message.text;
    }
    return null;
  }, [activeThread?.messages]);
  // The person's own plan ran out (T3 port 30.10, PlanRoomNotice): the stop
  // line is the turn's error (Codex) or — Claude Code ends the turn with it as
  // a short "answer" — the last reply of a finished turn.
  const planLimitStopText = useMemo(() => {
    if (planProviderForDriver(selectedProvider) === null) return null;
    if (isPlanLimitText(activeThread?.error)) return activeThread?.error ?? null;
    if (activeLatestTurn?.state === "running" || !activeLatestTurn?.completedAt) return null;
    const messages = activeThread?.messages ?? [];
    const last = messages[messages.length - 1];
    return last?.role === "assistant" && isPlanLimitText(last.text) ? last.text : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.state,
    activeThread?.error,
    activeThread?.messages,
    selectedProvider,
  ]);
  // The daemon goes on by itself after the reset (planResume/): "Resumes at 16:40".
  const planResume = useMemo(() => pendingPlanResume(threadActivities), [threadActivities]);
  const smartTargetHere = useMemo(() => unoSmartTarget(providerStatuses), [providerStatuses]);
  /**
   * "Continue with <account>": the person's click moves this chat to their
   * other account. The chat keeps running there, so its saved model goes too.
   */
  const onContinueWithAccount = useCallback(
    async (selection: ModelSelection) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThread || !isServerThread || isSendBusy || sendInFlightRef.current) return;
      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const createdAt = new Date().toISOString();
      const text = `${UNO_WORK_NOTE_PREFIX}${ACCOUNT_SWITCH_NOTE_BODY}`;
      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);
      isAtEndRef.current = true;
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, threadIdForSend),
        selection,
      );
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          modelSelection: selection,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: { messageId: messageIdForSend, role: "user", text, attachments: [] },
          modelSelection: selection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode,
          createdAt,
        });
        sendInFlightRef.current = false;
      } catch (error) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
        throw error;
      }
    },
    [
      activeThread,
      beginLocalDispatch,
      environmentId,
      interactionMode,
      isSendBusy,
      isServerThread,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftModelSelection,
      setThreadError,
    ],
  );
  const onRetryAfterReauth = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      !isServerThread ||
      !lastUserMessageText ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }
    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const modelSelection =
      composerRef.current?.getSendContext()?.selectedModelSelection ?? activeThread.modelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);
    isAtEndRef.current = true;
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: lastUserMessageText,
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: lastUserMessageText,
          attachments: [],
        },
        modelSelection,
        titleSeed: activeThread.title,
        runtimeMode,
        interactionMode,
        createdAt: messageCreatedAt,
      });
      sendInFlightRef.current = false;
    } catch (err) {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
      sendInFlightRef.current = false;
      resetLocalDispatch();
    }
  }, [
    activeThread,
    beginLocalDispatch,
    environmentId,
    interactionMode,
    isConnecting,
    isSendBusy,
    isServerThread,
    lastUserMessageText,
    resetLocalDispatch,
    runtimeMode,
    setThreadError,
  ]);

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId));
      })
      .then(() => {
        // The new chat opens with its tasks tab (it shows the plan being implemented).
        if (autoOpenPlanSidebar && !isEmbedded) {
          openTasksTab(nextThreadId, "person", "Plan");
        }
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the implementation chat",
            description:
              err instanceof Error ? err.message : "An error occurred while creating the new chat.",
          }),
        );
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    autoOpenPlanSidebar,
    environmentId,
    isEmbedded,
    openTasksTab,
  ]);

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread) {
        return;
      }

      if (filePath) {
        const name = filePath.split(/[\\/]/).pop() ?? filePath;
        const kind = detectFileKind(name);
        // text (код) → diff. Всё остальное (md/html/pdf/csv/json/image/xlsx/unknown) → preview-вкладка.
        if (kind !== "text") {
          const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath);
          const absolutePath =
            isAbsolute || !gitCwd ? filePath : `${gitCwd.replace(/[\\/]$/, "")}/${filePath}`;
          const projectCwd = activeProject?.cwd ?? gitCwd ?? null;
          openPreviewFile({
            id: absolutePath,
            name,
            kind,
            content: "",
            path: absolutePath,
            environmentId,
            ...(projectCwd ? { projectCwd } : {}),
          });
          return;
        }
      }

      onDiffPanelOpen?.();
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId,
        },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [
      activeProject?.cwd,
      environmentId,
      gitCwd,
      isServerThread,
      navigate,
      onDiffPanelOpen,
      openPreviewFile,
      threadId,
    ],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  const focusPreviewMessages = useMemo(() => {
    const messages = activeThread?.messages ?? [];
    return messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(fullscreenChatDock ? -8 : -2);
  }, [activeThread?.messages, fullscreenChatDock]);
  const latestFocusPreviewMessage = focusPreviewMessages[focusPreviewMessages.length - 1];
  const focusChatStatus = chatDockStatus({
    isWorking,
    hasPendingApproval: activePendingApproval !== null,
    hasPendingUserInput: pendingUserInputs.length > 0,
  });
  // The dense block holds the one-line composer; an approval or a question
  // brings the full composer back, and the step row then sits right above it.
  const focusChatComposerIsStrip = activePendingApproval === null && pendingUserInputs.length === 0;

  // Leaving full screen brings the chat back unfolded (dock only; 0.0.137 kept the mode).
  useEffect(() => {
    if (!isPreviewFocusMode && fullscreenChatDock) setFocusChatPanelMode("peek");
  }, [fullscreenChatDock, isPreviewFocusMode]);
  // The legacy preview knows no "minimized": a flag turned off mid-fold shows the pill.
  useEffect(() => {
    if (!fullscreenChatDock) {
      setFocusChatPanelMode((mode) => (mode === "minimized" ? "peek" : mode));
    }
  }, [fullscreenChatDock]);
  const restoreFocusChat = useCallback(() => setFocusChatPanelMode("peek"), []);
  const replyFromFocusChat = useCallback(() => {
    setFocusChatPanelMode("peek");
    // The composer is shown again on the next render; focus it after that.
    window.setTimeout(() => focusComposer(), 30);
  }, [focusComposer]);
  const openChatFromFocus = useCallback(() => {
    setFocusChatPanelMode("peek");
    setPreviewLayoutMode("sidebar");
  }, [setPreviewLayoutMode]);
  // The full-screen tab leaves exactly the dock's height at the bottom — and
  // nothing once the chat is folded away (P1, 28.10).
  const [focusComposerElement, setFocusComposerElement] = useState<HTMLDivElement | null>(null);
  useChatDockInset(focusComposerElement, {
    active: isPreviewFocusMode && showComposer,
    mode: isFocusChatMinimized ? "minimized" : focusChatPanelMode,
  });

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  // A failed turn and its "Try again" (flows v2, I1): at the end of the feed (S4).
  const threadErrorNotice = (placement: "banner" | "feed") => (
    <ThreadErrorBanner
      placement={placement}
      error={
        activeThread.session?.lastErrorClass === "billing_error" ||
        harnessAuth?.suppressThreadError ||
        // "Sign in or use Uno credits": the composer asks that itself.
        isUnoCreditsChoiceRequiredText(activeThread.error) ||
        // The plan is at its limit: ChatPlanLimitNotice says it, with the ways on.
        planLimitStopText !== null
          ? null
          : activeThread.error
      }
      onDismiss={() => setThreadError(activeThread.id, null)}
      // "Try again" sends the person's last message again (flows v2, I1).
      onRetry={isServerThread && lastUserMessageText ? () => void onRetryAfterReauth() : undefined}
      retryDisabled={isSendBusy || isConnecting}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {isDraggingOverWindow ? (
        <div
          className="pointer-events-none fixed inset-1.5 z-50 flex items-start justify-center rounded-2xl pt-4 ring-2 ring-primary/50"
          data-testid="chat-drop-overlay"
        >
          <span className="rounded-full bg-primary px-3 py-1 text-primary-foreground text-xs">
            Drop to add to this chat
          </span>
        </div>
      ) : null}
      {/* Top bar */}
      {!isPreviewFocusMode && !isEmbedded ? (
        <header
          className={cn(
            "border-b border-border",
            isElectron
              ? cn(
                  "drag-region flex h-[52px] items-center pr-3 sm:pr-5 wco:h-[env(titlebar-area-height)]",
                  sidebarHidden ? "pl-[78px] fullscreen:pl-3 sm:fullscreen:pl-5" : "pl-3 sm:pl-5",
                  reserveTitleBarControlInset &&
                    "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
                )
              : "pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
          )}
        >
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === "draft" && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            activeProjectName={activeProject?.name}
            activeProjectCwd={activeProject?.cwd}
            hideDraftFolderChip={isDraftHeroState}
            isGitRepo={isGitRepo}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            terminalAvailable={activeProject !== undefined}
            terminalOpen={terminalState.terminalOpen}
            terminalToggleShortcutLabel={terminalToggleShortcutLabel}
            diffToggleShortcutLabel={diffPanelShortcutLabel}
            panelToggleShortcutLabel={panelToggleShortcutLabel}
            gitCwd={gitCwd}
            diffOpen={diffOpen}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onToggleTerminal={toggleTerminalVisibility}
            onToggleDiff={onToggleDiff}
          />
        </header>
      ) : null}

      {/* Error banner */}
      {!isPreviewFocusMode ? (
        <>
          <ProviderStatusBanner
            status={
              // Assistant chats show Hermes' state in AssistantEngine; a lost
              // sign-in gets the in-chat HarnessReauthCard instead.
              harnessAuth?.isAssistant || harnessAuth?.loss ? null : activeProviderStatus
            }
            action={
              unoProviderFallbackTarget && lockedProvider === null
                ? {
                    label: "Switch to built-in Uno AI",
                    onClick: () =>
                      onProviderModelSelect(
                        unoProviderFallbackTarget.instanceId,
                        unoProviderFallbackTarget.model,
                      ),
                  }
                : null
            }
            hint={
              unoProviderFallbackTarget && lockedProvider !== null
                ? "Built-in Uno AI is available — start a new chat to use it."
                : null
            }
          />
          <CloudSleepsBanner
            environmentId={activeThread.environmentId}
            threadId={activeThread.id}
          />
          <UnoBillingTopUpBanner
            active={activeThread.session?.lastErrorClass === "billing_error"}
            sessionUpdatedAt={activeThread.session?.updatedAt ?? null}
            sessionError={activeThread.session?.lastError ?? activeThread.error ?? null}
            environmentId={activeThread.environmentId}
          />
          {/* A failed turn: a quiet line at the end of the feed (S4, upstream
              bd3287b640); a plate up here only when the feed is hidden. */}
          {showsTimeline(embeddedVisibility) ? null : threadErrorNotice("banner")}
        </>
      ) : null}
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          <div ref={setMessagesViewport} className="relative flex min-h-0 flex-1 flex-col">
            {activeThread ? (
              <ReplySelectionToolbar
                viewport={messagesViewport}
                onQuote={(quote) =>
                  useComposerQuotesStore.getState().add(activeThread.id, { ...quote, page: null })
                }
                onQuoteAndSend={(quote) => {
                  useComposerQuotesStore.getState().add(activeThread.id, { ...quote, page: null });
                  void onSendRef.current();
                }}
              />
            ) : null}
            {/* Messages — LegendList handles virtualization and scrolling internally */}
            {showsTimeline(embeddedVisibility) && !isDraftHeroState ? (
              <MessagesTimeline
                key={activeThread.id}
                isWorking={isWorking}
                messagesLoaded={!isServerThread || serverThreadDetailLoaded}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnId={activeLatestTurn?.turnId ?? null}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={visibleTimelineEntries}
                completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                completionSummary={completionSummary}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                onIsAtEndChange={onIsAtEndChange}
                latestTurn={activeLatestTurn}
                pendingApprovals={pendingApprovals}
                respondingRequestIds={respondingRequestIds}
                onRespondToApproval={onRespondToApproval}
                endOfFeed={
                  <>
                    <QueuedMessagesList
                      messages={queuedMessages}
                      onSendNow={onSendQueuedNow}
                      onEdit={onEditQueued}
                      onDelete={onDeleteQueued}
                    />
                    {threadErrorNotice("feed")}
                    {planLimitStopText !== null && isServerThread ? (
                      <ChatPlanLimitNotice
                        environmentId={activeThread.environmentId}
                        threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
                        driver={selectedProvider}
                        instanceId={
                          activeThread.session?.providerInstanceId ??
                          activeThread.modelSelection.instanceId
                        }
                        currentModel={activeThread.modelSelection.model}
                        stopText={planLimitStopText}
                        stoppedAt={activeLatestTurn?.completedAt ?? null}
                        lastRequest={lastUserMessageText ?? ""}
                        smartTarget={smartTargetHere}
                        canContinueWithHistory={isElectron && Boolean(activeProject)}
                        onContinueWithAccount={onContinueWithAccount}
                      />
                    ) : null}
                    {planResume !== null && isServerThread ? (
                      <PlanResumeLine
                        environmentId={activeThread.environmentId}
                        threadRef={scopeThreadRef(activeThread.environmentId, activeThread.id)}
                        resumeAt={planResume.resumeAt}
                      />
                    ) : null}
                  </>
                }
              />
            ) : null}

            {/* The feed dissolves into the composer instead of being cut off. */}
            {showsTimeline(embeddedVisibility) ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-linear-to-t from-background to-transparent" />
            ) : null}

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && showsTimeline(embeddedVisibility) && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 justify-center">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/70 bg-card/85 px-3 py-1 text-foreground/80 text-xs shadow-sm backdrop-blur-md transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to end
                </button>
              </div>
            )}
          </div>

          {isFocusChatMinimized ? (
            <ChatMiniWindow
              // Another chat opened while folded starts from what it has on screen.
              key={activeThread.id}
              variant={chatDockVariant}
              title={activeThread.title}
              status={focusChatStatus}
              messages={focusPreviewMessages}
              pendingApproval={activePendingApproval}
              approvalResponding={
                activePendingApproval !== null &&
                respondingRequestIds.includes(activePendingApproval.requestId)
              }
              onRespondToApproval={onRespondToApproval}
              onRestore={restoreFocusChat}
              onReply={replyFromFocusChat}
              onOpenChat={openChatFromFocus}
            />
          ) : null}
          {isPreviewFocusMode && !fullscreenChatDock ? (
            <LegacyFocusChatPreview
              mode={focusChatPanelMode === "expanded" ? "expanded" : "peek"}
              onModeChange={setFocusChatPanelMode}
              messages={focusPreviewMessages}
              sidebarVisible={sidebarVisible}
            />
          ) : null}

          {/* Input bar */}
          {showComposer ? (
            <div
              ref={setFocusComposerElement}
              className={cn(
                "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-1.5 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-2",
                isEmbedded && "px-2 pb-2 sm:px-2",
                isGitRepo
                  ? "pb-[calc(env(safe-area-inset-bottom)+0.25rem)]"
                  : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]",
                isPreviewFocusMode &&
                  "pointer-events-none fixed bottom-2 right-0 z-[70] border-0 bg-transparent px-4 pb-0 pt-0 sm:bottom-3 sm:px-6",
                // Folded into the mini window: the composer keeps its draft, out of sight.
                isFocusChatMinimized && "hidden",
              )}
              style={
                isPreviewFocusMode
                  ? { left: sidebarVisible ? "var(--sidebar-width)" : "0px" }
                  : undefined
              }
            >
              <div
                ref={draftHeroTransitionGroupRef}
                className={cn(
                  "relative isolate",
                  isPreviewFocusMode && "pointer-events-auto",
                  // ~800px in the middle, like the full composer (max-w-208).
                  isChatDockMode && "mx-auto w-full max-w-208",
                  // One dense block: the latest step is the top edge of the composer.
                  isChatDockMode &&
                    focusChatComposerIsStrip &&
                    "rounded-2xl border border-border/70 bg-card/95 shadow-xl shadow-black/10 backdrop-blur-xl",
                )}
                data-chat-dock={isChatDockMode ? "true" : undefined}
                data-draft-hero={isDraftHeroState ? "true" : undefined}
              >
                {isDraftHeroState && draftId && activeProject ? (
                  // Out of flow, above the box, so the composer itself is what's centred.
                  <div className="absolute inset-x-0 bottom-full pb-6">
                    <DraftHeroHeadline
                      environmentId={activeThread.environmentId}
                      draftId={draftId}
                      projectId={activeProject.id}
                      projectName={activeProject.name}
                      projectCwd={activeProject.cwd}
                    />
                  </div>
                ) : null}
                {isChatDockMode ? (
                  <FullscreenChatDockHeader
                    status={focusChatStatus}
                    latestStep={latestFocusPreviewMessage?.text ?? ""}
                    expanded={focusChatPanelMode === "expanded"}
                    messages={focusPreviewMessages}
                    onToggleExpanded={() =>
                      setFocusChatPanelMode((mode) => (mode === "expanded" ? "peek" : "expanded"))
                    }
                    onMinimize={() => setFocusChatPanelMode("minimized")}
                    detached={!focusChatComposerIsStrip}
                    markdownCwd={gitCwd ?? undefined}
                  />
                ) : null}
                {isServerThread &&
                (activeThread?.spawnedByThreadId || activeThread?.agentsClosedAt) ? (
                  <ThreadControlBar
                    environmentId={activeThread.environmentId}
                    threadId={activeThread.id}
                    spawnedByThreadId={activeThread.spawnedByThreadId}
                    controller={activeThread.controller}
                    agentsClosedAt={activeThread.agentsClosedAt}
                  />
                ) : null}
                {activeThread && isAssistantConversation(activeThread) ? (
                  <AssistantEngineBanner environmentId={activeThread.environmentId} />
                ) : null}
                {harnessAuth?.loss ? (
                  <HarnessReauthCard
                    key={`${activeThread.id}:${harnessAuth.loss.kind}:${harnessAuth.loss.driver}`}
                    loss={harnessAuth.loss}
                    environmentId={activeThread.environmentId}
                    providerStatus={harnessAuth.providerStatus}
                    {...(isServerThread && lastUserMessageText
                      ? { onRetry: onRetryAfterReauth }
                      : {})}
                    fallbackAction={
                      !harnessAuth.isAssistant &&
                      unoProviderFallbackTarget &&
                      lockedProvider === null
                        ? {
                            label: "Switch to built-in Uno AI",
                            onClick: () =>
                              onProviderModelSelect(
                                unoProviderFallbackTarget.instanceId,
                                unoProviderFallbackTarget.model,
                              ),
                          }
                        : null
                    }
                    onDismiss={() => setThreadError(activeThread.id, null)}
                  />
                ) : null}
                <AiBusyNotice
                  environmentId={activeThread?.environmentId ?? null}
                  active={
                    isWorking && (selectedProvider === "uno" || selectedProvider === "hermes")
                  }
                />
                <ComposerBannerStack
                  className="relative z-0"
                  items={
                    notificationSoftAskBanner && selfUpdate.view?.kind !== "updating"
                      ? [...composerBannerItems, notificationSoftAskBanner]
                      : composerBannerItems
                  }
                />
                {selfUpdate.dialog}
                <div className="relative z-10">
                  <ChatComposer
                    ref={composerRef}
                    composerDraftTarget={composerDraftTarget}
                    environmentId={environmentId}
                    routeKind={routeKind}
                    routeThreadRef={routeThreadRef}
                    draftId={draftId}
                    onDropFolder={onDropFolder}
                    activeThreadId={activeThreadId}
                    activeThreadEnvironmentId={activeThread?.environmentId}
                    activeThread={activeThread}
                    isServerThread={isServerThread}
                    isLocalDraftThread={isLocalDraftThread}
                    forceCompact={isPreviewFocusMode}
                    inDock={isChatDockMode}
                    hideRuntimeModeControl={isEmbedded}
                    phase={phase}
                    isConnecting={isConnecting}
                    isSendBusy={isSendBusy}
                    isPreparingWorktree={isPreparingWorktree}
                    environmentUnavailable={
                      // Existing chats stay writable offline: sends go to the outbox.
                      isServerThread ? null : activeEnvironmentUnavailableState
                    }
                    activePendingApproval={activePendingApproval}
                    pendingApprovals={pendingApprovals}
                    pendingUserInputs={pendingUserInputs}
                    activePendingProgress={activePendingProgress}
                    activePendingResolvedAnswers={activePendingResolvedAnswers}
                    activePendingIsResponding={activePendingIsResponding}
                    activePendingDraftAnswers={activePendingDraftAnswers}
                    activePendingQuestionIndex={activePendingQuestionIndex}
                    respondingRequestIds={respondingRequestIds}
                    showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                    activeProposedPlan={activeProposedPlan}
                    activePlan={activePlan as { turnId?: TurnId } | null}
                    sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                    planSidebarLabel={planSidebarLabel}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    interactionMode={interactionMode}
                    lockedProvider={lockedProvider}
                    providerStatuses={providerStatuses as ServerProvider[]}
                    activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
                    activeThreadModelSelection={activeThread?.modelSelection}
                    activeThreadActivities={activeThread?.activities}
                    resolvedTheme={resolvedTheme}
                    settings={settings}
                    keybindings={keybindings}
                    terminalOpen={Boolean(terminalState.terminalOpen)}
                    gitCwd={gitCwd}
                    promptRef={promptRef}
                    composerImagesRef={composerImagesRef}
                    composerVideosRef={composerVideosRef}
                    composerTerminalContextsRef={composerTerminalContextsRef}
                    shouldAutoScrollRef={isAtEndRef}
                    scheduleStickToBottom={scrollToEnd}
                    isEmbedded={isEmbedded}
                    onSend={onComposerSend}
                    onInterrupt={onInterrupt}
                    onImplementPlanInNewThread={onImplementPlanInNewThread}
                    onRespondToApproval={onRespondToApproval}
                    onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                    onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                    onAnswerActivePendingUserInput={onAnswerActivePendingUserInput}
                    onPreviousActivePendingUserInputQuestion={
                      onPreviousActivePendingUserInputQuestion
                    }
                    onChangeActivePendingUserInputCustomAnswer={
                      onChangeActivePendingUserInputCustomAnswer
                    }
                    onProviderModelSelect={onProviderModelSelect}
                    toggleInteractionMode={toggleInteractionMode}
                    handleRuntimeModeChange={handleRuntimeModeChange}
                    handleInteractionModeChange={handleInteractionModeChange}
                    togglePlanSidebar={togglePlanSidebar}
                    focusComposer={focusComposer}
                    scheduleComposerFocus={scheduleComposerFocus}
                    setThreadError={setThreadError}
                    onExpandImage={onExpandTimelineImage}
                  />
                </div>
              </div>
              {devMode && isGitRepo && !isEmbedded && (
                <BranchToolbar
                  environmentId={activeThread.environmentId}
                  threadId={activeThread.id}
                  {...(routeKind === "draft" && draftId ? { draftId } : {})}
                  onEnvModeChange={onEnvModeChange}
                  {...(canOverrideServerThreadEnvMode ? { effectiveEnvModeOverride: envMode } : {})}
                  {...(canOverrideServerThreadEnvMode
                    ? {
                        activeThreadBranchOverride: activeThreadBranch,
                        onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                      }
                    : {})}
                  envLocked={envLocked}
                  onComposerFocusRequest={scheduleComposerFocus}
                  {...(canCheckoutPullRequestIntoThread
                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                    : {})}
                  {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                  availableEnvironments={logicalProjectEnvironments}
                />
              )}
            </div>
          ) : null}

          {isDraftHeroState && draftId ? (
            // The lower half of the page: the composer sits between this and the
            // empty timeline above, in the middle; a few hints right under it.
            <div className="min-h-0 flex-1 overflow-hidden px-3 pt-1 sm:px-5">
              <div className="mx-auto flex w-full max-w-208 flex-col gap-3">
                <DraftPlanRoomNotice
                  environmentId={activeThread.environmentId}
                  draftId={draftId}
                  driver={selectedProvider}
                  instanceId={composerActiveProvider ?? activeProviderInstanceId}
                  smartTarget={smartTargetHere}
                  onUseModel={(selection) =>
                    onProviderModelSelect(selection.instanceId, selection.model)
                  }
                />
                <DraftHeroStarters
                  environmentId={activeThread.environmentId}
                  draftId={draftId}
                  onPicked={scheduleComposerFocus}
                />
              </div>
            </div>
          ) : null}

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}
      </div>
      {/* end horizontal flex container */}

      {(isEmbedded ? [] : mountedTerminalThreadRefs).map(
        ({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            visible={mountedThreadKey === activeThreadKey && terminalState.terminalOpen}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ),
      )}

      {expandedImage && (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      )}
    </div>
  );
}
