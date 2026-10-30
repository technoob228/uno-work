import {
  formatDuration,
  type PendingApproval,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import type { SupportDraft } from "@t3tools/shared/supportDraft";
import { liveThoughtFromReasoningTail, workEntryIsThought } from "./workLogSummary";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      /** The steps the agent is taking right now (the running turn's last run of steps). */
      live: boolean;
    }
  | {
      /** A finished turn's steps and notes, folded: "Worked for 2m 10s" (upstream 1916ac6d55). */
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      /** A page the agent showed: outside the fold, it's the answer. */
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      /** A letter to support: the person reads it and sends it (Fix Work). */
      kind: "support-draft";
      id: string;
      createdAt: string;
      draft: SupportDraft;
    }
  | {
      /** The agent waits for an OK: the question on its own row (upstream 1f8530ec3c). */
      kind: "pending-approval";
      id: string;
      createdAt: string;
      approval: PendingApproval;
      pendingCount: number;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** The agent's latest thought, one line (upstream 95ccbf4066); null: plain "Thinking". */
      thought: string | null;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

/** After this many seconds the wait line adds that the work goes on. */
export const WORKING_REASSURE_AFTER_SECONDS = 15;

/**
 * The words after the timer on the wait line ("Thinking · 28s"): nothing at
 * first, and past ~15 s a plain "still working" — the model's reasoning is not
 * shown, so a long quiet stretch otherwise reads as a hang. No promise that
 * "nothing is stuck": the turn can still end with "Uno AI didn't answer"
 * (flows v2, errors-catalog/3).
 */
export function workingReassurance(elapsedSeconds: number): string | null {
  return elapsedSeconds >= WORKING_REASSURE_AFTER_SECONDS ? "still working" : null;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export { normalizeCompactToolLabel } from "./workLogSummary";

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * The latest turn counts as unsettled while it is still running (or has not
 * recorded a completion). Keyed on the turn's own lifecycle, not on the
 * transient working state, so folding does not flicker right after a send
 * (upstream 1916ac6d55).
 */
function deriveUnsettledTurnId(latestTurn: TimelineLatestTurn | null): TurnId | null {
  if (!latestTurn) return null;
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

export interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

/**
 * Finished turns fold their steps and in-between notes behind a "Worked for
 * 2m 10s" row anchored at the turn's first foldable entry; the turn's last
 * answer stays visible below the fold (upstream 1916ac6d55 `deriveTurnFolds`).
 * A turn that ended on an error without an answer stays open: the person
 * must see what went wrong.
 */
export function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    hasError: boolean;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  for (const entry of input.timelineEntries) {
    const turnId = timelineEntryTurnId(entry);
    if (!turnId) continue;
    const group = groupsByTurnId.get(turnId) ?? {
      entries: [],
      terminalEntry: null,
      hasStreamingMessage: false,
      hasError: false,
    };
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) group.terminalEntry = entry;
      if (entry.message.streaming) group.hasStreamingMessage = true;
    } else if (entry.kind === "work" && entry.entry.tone === "error") {
      group.hasError = true;
    }
    groupsByTurnId.set(turnId, group);
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId || group.hasStreamingMessage) continue;
    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A stopped turn is the person's own doing, not a failure: it folds even
    // when a step broke off (upstream f3b058cd6a).
    if (group.terminalEntry === null && group.hasError && !isLatestInterruptedTurn) continue;
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) continue;

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) continue;

    const isLatestTurn = input.latestTurn?.turnId === turnId;
    const elapsedMs =
      isLatestTurn && input.latestTurn?.startedAt && input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            firstEntry.createdAt,
            group.terminalEntry?.message.completedAt ??
              (lastEntry.kind === "message"
                ? (lastEntry.message.completedAt ?? lastEntry.createdAt)
                : lastEntry.createdAt),
          );
    const duration = elapsedMs !== null && elapsedMs >= 1000 ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

/**
 * The live line's thought: the latest reasoning row of the running turn
 * (after the person's last message), as one sentence.
 */
function deriveLiveThought(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unsettledTurnId: TurnId | null,
): string | null {
  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (!entry) continue;
    if (entry.kind === "message" && entry.message.role === "user") return null;
    if (entry.kind !== "work" || !workEntryIsThought(entry.entry)) continue;
    if (unsettledTurnId !== null && entry.entry.turnId && entry.entry.turnId !== unsettledTurnId) {
      return null;
    }
    const line = liveThoughtFromReasoningTail(entry.entry.detail ?? "");
    return line.length > 0 ? line : null;
  }
  return null;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  latestTurn?: TimelineLatestTurn | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  pendingApprovals?: ReadonlyArray<PendingApproval>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(input.latestTurn ?? null);
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const foldedTurnIds = new Set<TurnId>();
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    foldedTurnIds.add(fold.turnId);
    if (input.expandedTurnIds?.has(fold.turnId)) continue;
    for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
  }
  const lastUserIndex = input.timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        // The running turn's steps after the person's last message, with
        // nothing after them yet: what the agent is doing right now.
        live: input.isWorking && index > lastUserIndex && cursor >= input.timelineEntries.length,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "support-draft") {
      nextRows.push({
        kind: "support-draft",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        draft: timelineEntry.draft,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      // A folded turn says "Worked for …" on its fold row already.
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id &&
        !(timelineEntry.message.turnId && foldedTurnIds.has(timelineEntry.message.turnId)),
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  const pendingApproval = input.pendingApprovals?.[0];
  if (pendingApproval) {
    nextRows.push({
      kind: "pending-approval",
      id: `pending-approval:${pendingApproval.requestId}`,
      createdAt: pendingApproval.createdAt,
      approval: pendingApproval,
      pendingCount: input.pendingApprovals?.length ?? 1,
    });
  }

  // Waiting for the person's OK is not "Thinking": the question row says it.
  if (input.isWorking && !pendingApproval) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      thought: deriveLiveThought(input.timelineEntries, unsettledTurnId),
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working": {
      const bw = b as typeof a;
      return a.createdAt === bw.createdAt && a.thought === bw.thought;
    }

    case "pending-approval": {
      const ba = b as typeof a;
      return a.approval === ba.approval && a.pendingCount === ba.pendingCount;
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render":
      return htmlRenderReferencesEqual(a.htmlRender, (b as typeof a).htmlRender);

    case "support-draft":
      return a.draft === (b as typeof a).draft;

    case "work": {
      const bw = b as typeof a;
      return a.groupedEntries === bw.groupedEntries && a.live === bw.live;
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

/** The folded "Changed files" line under an answer: "Changed 1 file" / "Changed 3 files". */
export function changedFilesSummaryLabel(count: number): string {
  return `Changed ${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * A changed-files path as the person reads it: their home folder is `~`, never
 * `/home/unowork/…` (the tree's directory names are compacted, so a whole
 * "home/unowork/projects/bot" can be one node).
 */
export function displayChangedFilePath(path: string): string {
  return path.replace(/^\/?home\/[^/]+(?=\/|$)/u, "~");
}

/** Text from outside Uno is in this chat (the server's automations/prompt.ts writes this tag). */
export function holdsOutsideText(
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly message?: { readonly role: string; readonly text: string };
  }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.message?.role === "user" &&
      entry.message.text.includes("<outside_input_"),
  );
}
