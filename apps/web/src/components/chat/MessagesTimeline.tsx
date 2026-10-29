import { RecordingMessageCard } from "../../screenRecording/RecordingCards";
import { KEY_FRAME_PREFIX } from "../../screenRecording/agentView";
import { extractRecordingBlock } from "../../screenRecording/recordingLogic";
import { localRecordingUrl } from "../../screenRecording/recordingStore";
import {
  type ApprovalRequestId,
  type EnvironmentId,
  type MessageId,
  type ProviderApprovalDecision,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { cleanUnoFinalAnswerText } from "@t3tools/shared/unoFinalAnswer";
import { parseUnoWorkNote, type UnoWorkNote } from "@t3tools/shared/secretRequestCopy";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed, type PendingApproval } from "../../session-logic";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import { useDevMode } from "../../devMode";
import { describeHandoffSeed, isHandoffSeed } from "../../continueOnMachine";
import { isUnoAiHandoff } from "../../unoai/unoAiHandoff";
import { UnoAiHandoffCard } from "./UnoAiHandoffCard";
import { AutomationCreatedCard } from "../automations/AutomationCreatedCard";
import { automationFromToolResult } from "../automations/automations.logic";
import { CONTINUE_ON_MACHINE_COPY } from "../../continueOnMachineCopy";
import {
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ChatVideoDigestAttachment,
  type TurnDiffSummary,
} from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FileIcon,
  FileVideoIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  MonitorSmartphoneIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { userImagePanelTab } from "./userImageTab";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  changedFilesSummaryLabel,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  workingReassurance,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { summarizeToolGroup, toolGroupAction, workEntryIsStep } from "./workLogSummary";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { useNavigate } from "@tanstack/react-router";
import { describeAgentSentMessage } from "~/agentThreads.logic";
import { useThreadTitle } from "~/hooks/useThreadTitle";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { detectFileKind, usePreviewPane } from "../preview/PreviewPaneContext";
import { formatFileSize } from "../files/fileTypes";
import { displayUploadPath } from "../../chatUploads";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  completionSummary: string | null;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  /** Call before opening/closing a part of the feed: at the end, the end stays in view. */
  onDisclosureToggle: () => void;
  respondingRequestIds: ReadonlyArray<ApprovalRequestId>;
  onRespondToApproval:
    | ((requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => Promise<void>)
    | undefined;
}

const EMPTY_PENDING_APPROVALS: ReadonlyArray<PendingApproval> = [];
const EMPTY_REQUEST_IDS: ReadonlyArray<ApprovalRequestId> = [];

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /** The chat's latest turn: a finished one folds into "Worked for …". */
  latestTurn?: TimelineLatestTurn | null;
  /**
   * The chat's state at the very end of the feed, as quiet lines (a failed
   * turn and its "Try again"), instead of a plate above the chat.
   */
  endOfFeed?: ReactNode;
  /** The agent's open questions before a step: the first shows on the feed's last row. */
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  respondingRequestIds?: ReadonlyArray<ApprovalRequestId>;
  onRespondToApproval?: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onIsAtEndChange,
  latestTurn = null,
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  respondingRequestIds = EMPTY_REQUEST_IDS,
  onRespondToApproval,
  endOfFeed = null,
}: MessagesTimelineProps) {
  // Folded turns the person opened (the list is keyed per chat in ChatView).
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(() => new Set());
  // A toggle made at the end keeps the end in view while rows re-measure;
  // anywhere else the list holds the toggled row in place (upstream 1cfd1c1a44).
  const pinEndUntilRef = useRef(0);
  const pinToEnd = useCallback(() => {
    void listRef.current?.scrollToEnd?.({ animated: false });
  }, [listRef]);
  const onDisclosureToggle = useCallback(() => {
    if (listRef.current?.getState?.()?.isAtEnd !== true) return;
    pinEndUntilRef.current = performance.now() + 500;
    requestAnimationFrame(() => {
      pinToEnd();
      requestAnimationFrame(pinToEnd);
    });
  }, [listRef, pinToEnd]);
  const handleItemSizeChanged = useCallback(() => {
    if (performance.now() < pinEndUntilRef.current) pinToEnd();
  }, [pinToEnd]);
  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      onDisclosureToggle();
      setExpandedTurnIds((current) => {
        const next = new Set(current);
        if (next.has(turnId)) next.delete(turnId);
        else next.add(turnId);
        return next;
      });
    },
    [onDisclosureToggle],
  );
  const latestTurnId = latestTurn?.turnId ?? null;
  const latestTurnState = latestTurn?.state ?? null;
  const latestTurnStartedAt = latestTurn?.startedAt ?? null;
  const latestTurnCompletedAt = latestTurn?.completedAt ?? null;
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
        latestTurn:
          latestTurnId && latestTurnState
            ? {
                turnId: latestTurnId,
                state: latestTurnState,
                startedAt: latestTurnStartedAt,
                completedAt: latestTurnCompletedAt,
              }
            : null,
        expandedTurnIds,
        pendingApprovals,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
      latestTurnId,
      latestTurnState,
      latestTurnStartedAt,
      latestTurnCompletedAt,
      expandedTurnIds,
      pendingApprovals,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  // Memoised context value — only changes on state transitions, NOT on
  // every streaming chunk. Callbacks from ChatView are useCallback-stable.
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onDisclosureToggle,
      respondingRequestIds,
      onRespondToApproval,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onDisclosureToggle,
      respondingRequestIds,
      onRespondToApproval,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
        {endOfFeed ? <div className="w-full max-w-3xl px-3 sm:px-5">{endOfFeed}</div> : null}
      </div>
    );
  }

  return (
    <TimelineRowCtx.Provider value={sharedState}>
      <LegendList<MessagesTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        onScroll={handleScroll}
        onItemSizeChanged={handleItemSizeChanged}
        className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
        ListHeaderComponent={TIMELINE_LIST_HEADER}
        ListFooterComponent={
          endOfFeed ? (
            <div className="mx-auto w-full min-w-0 max-w-3xl">
              {endOfFeed}
              {TIMELINE_LIST_FOOTER}
            </div>
          ) : (
            TIMELINE_LIST_FOOTER
          )
        }
      />
    </TimelineRowCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function formatVideoDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** "From the agent in “<thread>”" above a user message another chat's agent sent. */
const AgentSentMessageLabel = memo(function AgentSentMessageLabel({
  sentByThreadId,
}: {
  sentByThreadId: ThreadId;
}) {
  const ctx = use(TimelineRowCtx);
  const senderTitle = useThreadTitle(ctx.activeThreadEnvironmentId, sentByThreadId);
  const navigate = useNavigate();
  const label = describeAgentSentMessage(senderTitle);
  return (
    <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
      <BotIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
      {senderTitle ? (
        <button
          type="button"
          title="Open the chat this message came from"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: ctx.activeThreadEnvironmentId, threadId: sentByThreadId },
            })
          }
          className="cursor-pointer truncate rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        >
          {label}
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </div>
  );
});

function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && (
        <WorkGroupSection groupedEntries={row.groupedEntries} live={row.live} />
      )}

      {row.kind === "pending-approval" && (
        <TimelinePendingApprovalRow
          approval={row.approval}
          pendingCount={row.pendingCount}
          isResponding={ctx.respondingRequestIds.includes(row.approval.requestId)}
          onRespondToApproval={ctx.onRespondToApproval}
        />
      )}

      {row.kind === "turn-fold" && (
        <TurnFoldRow
          turnId={row.turnId}
          label={row.label}
          expanded={row.expanded}
          createdAt={row.createdAt}
        />
      )}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          // A note the computer wrote for the agent (a late secret answer):
          // one quiet line, not the person's own bubble.
          const note = parseUnoWorkNote(row.message.text);
          if (note) return <UnoWorkNoteLine note={note} raw={row.message.text} />;
          const userAttachments = row.message.attachments ?? [];
          const allUserImages = userAttachments.filter(
            (attachment): attachment is ChatImageAttachment => attachment.type === "image",
          );
          // A screen recording's key frames show inside its card, not as photos.
          const recordingFrames = allUserImages.filter((image) =>
            image.name.startsWith(KEY_FRAME_PREFIX),
          );
          const userImages = allUserImages.filter(
            (image) => !image.name.startsWith(KEY_FRAME_PREFIX),
          );
          const userVideos = userAttachments.filter(
            (attachment): attachment is ChatVideoDigestAttachment =>
              attachment.type === "video_digest",
          );
          const userFiles = userAttachments.filter(
            (attachment): attachment is ChatFileAttachment => attachment.type === "file",
          );
          const displayedWithRecording = deriveDisplayedUserMessageState(row.message.text);
          // Loom Work: a screen recording block shows as a player card.
          const recordingPart = extractRecordingBlock(displayedWithRecording.visibleText);
          const displayedUserMessage = recordingPart.recording
            ? { ...displayedWithRecording, visibleText: recordingPart.text }
            : displayedWithRecording;
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          const sentByThreadId = row.message.sentByThreadId ?? null;
          return (
            <div className="flex justify-end">
              <div
                className={cn(
                  "group relative max-w-[80%] rounded-2xl rounded-br-sm border px-4 py-3",
                  // Sent by another chat's agent: same side, but visibly not the human's own bubble.
                  sentByThreadId
                    ? "border-dashed border-info/30 bg-info/4"
                    : "border-border bg-secondary",
                )}
                data-sent-by-agent={sentByThreadId ? "true" : undefined}
              >
                {sentByThreadId && <AgentSentMessageLabel sentByThreadId={sentByThreadId} />}
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map((image) => (
                      <div
                        key={image.id}
                        className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                      >
                        {image.previewUrl ? (
                          <UserImageThumb
                            image={image}
                            previewUrl={image.previewUrl}
                            images={userImages}
                          />
                        ) : (
                          <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                            {image.name}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {userVideos.length > 0 && (
                  <div className="mb-2 flex max-w-[420px] flex-col gap-1.5">
                    {userVideos.map((video) => (
                      <div
                        key={video.id}
                        className="flex min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground"
                      >
                        <FileVideoIcon className="size-4 shrink-0 text-foreground/70" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground/80">
                            {video.name}
                          </div>
                          <div className="truncate text-[11px]">
                            {formatVideoDuration(video.durationMs)} · {video.frameCount} frames ·{" "}
                            {video.transcriptSegmentCount} transcript segments
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {recordingPart.recording ? (
                  <RecordingMessageCard
                    recording={recordingPart.recording}
                    frames={recordingFrames.map((image) => ({
                      id: image.id,
                      name: image.name,
                      previewUrl: image.previewUrl ?? null,
                    }))}
                    localUrl={localRecordingUrl(recordingPart.recording.name)}
                  />
                ) : null}
                {userFiles.length > 0 && (
                  <div className="mb-2 flex max-w-[420px] flex-col gap-1.5">
                    {userFiles.map((file) => (
                      <UserFileAttachmentChip key={file.id} file={file} />
                    ))}
                  </div>
                )}
                {isUnoAiHandoff(displayedUserMessage.visibleText) ? (
                  <UnoAiHandoffCard text={displayedUserMessage.visibleText} />
                ) : isHandoffSeed(displayedUserMessage.visibleText) ? (
                  <HandoffSeedBody text={displayedUserMessage.visibleText} />
                ) : (
                  (displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                    />
                  )
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          // Any harness can leak the final-answer marker; it is never shown.
          const cleanText = cleanUnoFinalAnswerText(row.message.text ?? "");
          const messageText = cleanText || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ? cleanText : null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {ctx.completionSummary ? `Response • ${ctx.completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                  environmentId={ctx.activeThreadEnvironmentId}
                />
                <AssistantChangedFilesSection
                  turnSummary={row.assistantTurnDiffSummary}
                  routeThreadKey={ctx.routeThreadKey}
                  resolvedTheme={ctx.resolvedTheme}
                  onOpenTurnDiff={ctx.onOpenTurnDiff}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex min-w-0 items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex shrink-0 items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            {row.thought ? (
              // The agent's latest thought in its words, not a bare "Thinking"
              // (upstream 95ccbf4066); the timer stays, the reassurance goes.
              <span className="flex min-w-0 items-center" data-testid="live-thought">
                <span className="truncate text-muted-foreground" title={row.thought}>
                  {row.thought}
                </span>
                {row.createdAt ? (
                  <span className="ml-1 shrink-0 tabular-nums">
                    {"· "}
                    <WorkingTimer createdAt={row.createdAt} reassure={false} />
                  </span>
                ) : null}
              </span>
            ) : (
              <span>
                {row.createdAt ? (
                  <>
                    Thinking · <WorkingTimer createdAt={row.createdAt} />
                  </>
                ) : (
                  "Thinking…"
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking components — bypass LegendList memoisation entirely.
// Each owns a `nowMs` state value consumed in the render output so the
// React Compiler cannot elide the re-render as a no-op.
// ---------------------------------------------------------------------------

/** Live "28s" of the wait line, and past ~15 s the words that nothing is stuck. */
function WorkingTimer({ createdAt, reassure = true }: { createdAt: string; reassure?: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  const startedAtMs = Date.parse(createdAt);
  const reassurance =
    reassure && Number.isFinite(startedAtMs)
      ? workingReassurance(Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)))
      : null;
  return (
    <>
      {formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? "0s"}
      {reassurance ? ` · ${reassurance}` : null}
    </>
  );
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/**
 * A run of the agent's steps. Two or more read as one phrase — "Read 3 files
 * and ran 2 commands" (upstream 4a9edff4c1 #7152) — that opens to the
 * steps; one step stays its own line. What the person must see is never
 * folded away: a failure that isn't a tool's, an automation's card. Owns its
 * open/closed state so toggling re-renders only this row.
 */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  live,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  live: boolean;
}) {
  const { workspaceRoot, onDisclosureToggle, timestampFormat } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { summary, hasFailure } = useMemo(
    () => summarizeToolGroup(groupedEntries),
    [groupedEntries],
  );

  const renderEntry = (workEntry: TimelineWorkEntry) => {
    // An assistant made an automation: its card, from the call's result (28.10).
    const automation =
      workEntry.toolName === "automation_create"
        ? automationFromToolResult(workEntry.rawResult)
        : null;
    return automation ? (
      <AutomationCreatedCard key={`work-row:${workEntry.id}`} automation={automation} />
    ) : (
      <SimpleWorkEntryRow
        key={`work-row:${workEntry.id}`}
        workEntry={workEntry}
        workspaceRoot={workspaceRoot}
      />
    );
  };

  // One step (with or without notes around it) stays its own row: a phrase
  // would say less than the row itself.
  if (groupedEntries.filter(workEntryIsStep).length < 2) {
    return <div className="space-y-0.5">{groupedEntries.map(renderEntry)}</div>;
  }

  // Shown even while folded: an automation's card and a failure that is not a
  // tool's (a runtime error — a failed tool only marks the phrase).
  const pinned = groupedEntries.filter(
    (entry) =>
      entry.toolName === "automation_create" || (entry.tone === "error" && !entry.itemType),
  );
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES * 2;
  const visibleEntries =
    hasOverflow && !showAll
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES * 2)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const ToggleIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div data-testid="work-group">
      <div className="group/timeline-row flex items-center gap-2">
        <button
          type="button"
          data-scroll-anchor-ignore
          data-testid="work-group-summary"
          aria-expanded={isExpanded}
          className="group/summary flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pl-1 pr-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            onDisclosureToggle();
            setIsExpanded((value) => !value);
          }}
        >
          <span className="truncate">
            {summary}
            {live ? "…" : null}
          </span>
          {hasFailure ? (
            <CircleAlertIcon
              aria-label="A step failed"
              className="size-3 shrink-0 text-amber-600/80 dark:text-amber-400/80"
            />
          ) : null}
          <ToggleIcon className="size-3 shrink-0 opacity-60 group-hover/summary:opacity-100" />
        </button>
        <TimelineRowTimestamp
          createdAt={groupedEntries[0]?.createdAt ?? ""}
          timestampFormat={timestampFormat}
        />
      </div>
      {isExpanded ? (
        <div className="mt-1 ml-2 space-y-0.5 border-l border-border/60 pl-2">
          {hiddenCount > 0 ? (
            <button
              type="button"
              data-scroll-anchor-ignore
              className="px-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => {
                onDisclosureToggle();
                setShowAll(true);
              }}
            >
              Show {hiddenCount} earlier {hiddenCount === 1 ? "step" : "steps"}
            </button>
          ) : null}
          {visibleEntries.map(renderEntry)}
        </div>
      ) : pinned.length > 0 ? (
        <div className="mt-1 space-y-0.5">{pinned.map(renderEntry)}</div>
      ) : null}
    </div>
  );
});

/**
 * The time of a step or a fold, shown on hover or focus of its row (the row
 * carries `group/timeline-row`; upstream b900fc94eb). Takes no room while hidden.
 */
function TimelineRowTimestamp(props: { createdAt: string; timestampFormat: TimestampFormat }) {
  if (!props.createdAt) return null;
  return (
    <span className="pointer-events-none shrink-0 text-[10px] whitespace-nowrap text-muted-foreground/60 tabular-nums opacity-0 transition-opacity duration-100 group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:opacity-100">
      {formatTimestamp(props.createdAt, props.timestampFormat)}
    </span>
  );
}

/** "Worked for 2m 10s" — a finished turn's steps and notes, folded (upstream 1916ac6d55). */
const TurnFoldRow = memo(function TurnFoldRow(props: {
  turnId: TurnId;
  label: string;
  expanded: boolean;
  createdAt: string;
}) {
  const { onToggleTurnFold, timestampFormat } = use(TimelineRowCtx);
  const ToggleIcon = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="group/timeline-row flex items-center gap-3" data-testid="turn-fold">
      <button
        type="button"
        data-scroll-anchor-ignore
        aria-expanded={props.expanded}
        className="group/fold flex items-center gap-1.5 rounded-md py-0.5 pl-1 pr-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => onToggleTurnFold(props.turnId)}
      >
        <span>{props.label}</span>
        <ToggleIcon className="size-3 shrink-0 opacity-60 group-hover/fold:opacity-100" />
      </button>
      <span className="h-px flex-1 bg-border/60" />
      <TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={timestampFormat} />
    </div>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);
  // Most people never read a file tree: one quiet line they can open; the
  // full tree right away only in Dev mode (live walkthrough 05.10.2026).
  const devMode = useDevMode();
  const [shown, setShown] = useState(devMode);

  if (!shown) {
    return (
      <button
        type="button"
        data-scroll-anchor-ignore
        data-testid="changed-files-summary"
        className="mt-2 inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShown(true)}
      >
        <ChevronRightIcon className="size-3" />
        {changedFilesSummaryLabel(checkpointFiles.length)}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

/**
 * A user message that opens with a handoff preamble (the seed of a chat
 * continued from another machine, or a Telegram handoff). The carried
 * history can be thousands of characters, so it renders as a compact card
 * collapsed by default; anything after the preamble (the person's own
 * message, a model note) stays visible.
 */
const HandoffSeedBody = memo(function HandoffSeedBody(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeHandoffSeed(props.text);
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex flex-col gap-2" data-testid="handoff-seed">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <MonitorSmartphoneIcon className="size-3.5 shrink-0 text-muted-foreground" />
          {CONTINUE_ON_MACHINE_COPY.seedCardTitle(summary.sourceMachineLabel)}
        </span>
        <span className="text-muted-foreground">
          · {CONTINUE_ON_MACHINE_COPY.seedCardCount(summary.earlierMessages)}
        </span>
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ToggleIcon className="size-3 shrink-0" />
          {expanded
            ? CONTINUE_ON_MACHINE_COPY.seedHideHistory
            : CONTINUE_ON_MACHINE_COPY.seedShowHistory}
        </button>
      </div>
      {expanded ? (
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-background/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {props.text}
        </div>
      ) : null}
      {!expanded && summary.tail.length > 0 ? (
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          {summary.tail}
        </div>
      ) : null}
    </div>
  );
});

/**
 * A message Uno Work put into the chat for the agent ("(Uno Work) The person
 * entered TELEGRAM_BOT_TOKEN — it is saved in /home/…", the assistant's work
 * update, a scheduled task's prompt): the person reads one centred line in
 * their words; Dev mode shows what the agent got.
 */
const UnoWorkNoteLine = memo(function UnoWorkNoteLine(props: { note: UnoWorkNote; raw: string }) {
  const devMode = useDevMode();
  return (
    <div
      className="flex justify-center px-4"
      data-testid="uno-work-note"
      data-note-kind={props.note.kind}
    >
      <p
        className="max-w-[80%] text-center text-xs text-muted-foreground"
        title={devMode ? props.raw : undefined}
      >
        {props.note.text}
        {devMode ? (
          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/60 wrap-break-word">
            {props.raw}
          </span>
        ) : null}
      </p>
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  // The harnesses report reads and searches as generic tool calls: name them by kind.
  const action = toolGroupAction(workEntry);
  if (action === "read") return EyeIcon;
  if (action === "code-search") return SearchIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

/**
 * A picture the person attached: its copy in ~/Uploads opens beside the chat
 * (Misha 16.10 p.7); one with no copy on the computer opens full screen.
 */
const UserImageThumb = memo(function UserImageThumb(props: {
  image: ChatImageAttachment;
  previewUrl: string;
  images: ReadonlyArray<ChatImageAttachment>;
}) {
  const { image, previewUrl, images } = props;
  const { activeThreadEnvironmentId, onImageExpand } = use(TimelineRowCtx);
  const { openFile } = usePreviewPane();
  return (
    <button
      type="button"
      className="h-full w-full cursor-zoom-in"
      aria-label={`Preview ${image.name}`}
      onClick={() => {
        const tab = userImagePanelTab(image, activeThreadEnvironmentId);
        if (tab) {
          openFile(tab);
          return;
        }
        const preview = buildExpandedImagePreview(images, image.id);
        if (!preview) return;
        onImageExpand(preview);
      }}
    >
      <img
        src={previewUrl}
        alt={image.name}
        className="block h-auto max-h-[220px] w-full object-cover"
      />
    </button>
  );
});

/** A non-image file the person attached: opens from ~/Uploads in the side panel. */
const UserFileAttachmentChip = memo(function UserFileAttachmentChip(props: {
  file: ChatFileAttachment;
}) {
  const { file } = props;
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const { openFile } = usePreviewPane();
  const body = (
    <>
      <FileIcon className="size-4 shrink-0 text-foreground/70" />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate font-medium text-foreground/80">{file.name}</div>
        <div className="truncate text-[11px]">
          {formatFileSize(file.sizeBytes)}
          {file.path ? ` · ${displayUploadPath(file.path)}` : " · Sending…"}
        </div>
      </div>
    </>
  );
  const className =
    "flex min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground";
  if (!file.path) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={cn(className, "cursor-pointer hover:bg-background")}
      title={file.path}
      onClick={() =>
        openFile({
          id: file.path,
          name: file.name,
          kind: detectFileKind(file.name),
          content: "",
          path: file.path,
          environmentId: activeThreadEnvironmentId,
        })
      }
    >
      {body}
    </button>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const { activeThreadEnvironmentId, timestampFormat } = use(TimelineRowCtx);
  const { openFile } = usePreviewPane();
  const handleOpenWorkFile = useCallback(
    (filePath: string) => {
      const isAbsolute = filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath);
      const absolutePath =
        isAbsolute || !workspaceRoot
          ? filePath
          : `${workspaceRoot.replace(/[\\/]$/, "")}/${filePath}`;
      const name = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
      const kind = detectFileKind(name);
      openFile({
        id: absolutePath,
        name,
        kind,
        content: "",
        path: absolutePath,
        environmentId: activeThreadEnvironmentId,
        ...(workspaceRoot ? { projectCwd: workspaceRoot } : {}),
      });
    },
    [activeThreadEnvironmentId, openFile, workspaceRoot],
  );
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  // What the tool got and returned: for people who asked to see it (Dev mode).
  const devMode = useDevMode();
  const [rawOpen, setRawOpen] = useState(false);
  const hasRaw = devMode && Boolean(workEntry.rawInput || workEntry.rawResult);
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="group/timeline-row rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
                title={displayText}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
        {hasRaw && (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-[10px] text-muted-foreground/55 transition-colors hover:bg-accent hover:text-foreground"
            aria-expanded={rawOpen}
            data-testid="work-entry-raw-toggle"
            onClick={() => setRawOpen((open) => !open)}
          >
            {rawOpen ? "Hide raw" : "Raw"}
          </button>
        )}
      </div>
      {hasRaw && rawOpen && (
        // The call on top, its result muted under it, no card around either
        // (upstream df4ae529ea).
        <div
          className="mt-1 ml-6 max-h-64 overflow-auto font-mono text-[10px] leading-4 whitespace-pre-wrap wrap-break-word"
          data-testid="work-entry-raw"
        >
          {workEntry.rawInput ? (
            <div className="text-foreground/80">{workEntry.rawInput}</div>
          ) : null}
          {workEntry.rawResult ? (
            <div className="mt-1 border-l border-border/60 pl-2 text-muted-foreground/70">
              {workEntry.rawResult}
            </div>
          ) : null}
        </div>
      )}
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <button
                type="button"
                key={`${workEntry.id}:${filePath}`}
                onClick={() => handleOpenWorkFile(filePath)}
                className="cursor-pointer rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75 transition-colors hover:border-border hover:bg-background hover:text-foreground"
                title={displayPath}
              >
                {displayPath}
              </button>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
