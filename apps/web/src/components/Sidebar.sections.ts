// Inbox-zero sections for one project's chat list: Pinned -> Active ->
// Snoozed (collapsed shelf) -> Settled (quiet, time-ordered, first few shown).
//
// Ported from upstream T3 Code's Sidebar.logic.ts section model, adapted:
// - Settlement is derived on the client (upstream settles server-side with a
//   settledOverride column). The rule is upstream's inactivity auto-settle
//   (ThreadSettlementPolicy) with its default of 3 idle days.
// - Pinned threads never settle: in our fork a pin means "keep this in view".
// - A thread that needs the person (approval / question) is never hidden: it
//   leaves the snoozed shelf and sorts to the top of Active (or stays in
//   Pinned when pinned).
// - No drag between sections (upstream Sidebar.drag / Sidebar.motion); our
//   rows are not a sortable list and pin order is by pin time.
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreadsPinnedFirst, sortThreads, toSortableTimestamp } from "../lib/threadSort";
import { isLatestTurnSettled } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import { hasQueuedTurnStart, isThreadSnoozed, threadNeedsUser } from "./Sidebar.snooze";

export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";

/** Upstream's default `sidebarAutoSettleAfterDays`. */
export const SIDEBAR_SETTLE_AFTER_IDLE_MS = 3 * 24 * 60 * 60 * 1_000;
/** Settled rows shown before "Show more". */
export const SIDEBAR_SETTLED_PREVIEW_LIMIT = 5;

export type SidebarSectionThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "pinnedAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestUserMessageAt"
  | "latestTurn"
  | "session"
>;

function latestTimestampMs(values: ReadonlyArray<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const parsed = toSortableTimestamp(value ?? undefined);
    if (parsed !== null && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/** When the thread last did anything: a user message or a turn edge. */
export function resolveThreadActivityMs(thread: SidebarSectionThread): number | null {
  return latestTimestampMs([
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]);
}

/**
 * Settled: the latest turn finished, nothing is running or waiting on the
 * person, and the thread has been idle longer than the threshold. Threads
 * that never ran a turn stay active (upstream: no activity, no settlement).
 */
export function isThreadSettled(thread: SidebarSectionThread, now: string): boolean {
  if (threadNeedsUser(thread)) return false;
  const orchestrationStatus = thread.session?.orchestrationStatus;
  if (orchestrationStatus === "starting" || orchestrationStatus === "running") return false;
  if (thread.session?.status === "running" || thread.session?.status === "connecting") {
    return false;
  }
  if (!isLatestTurnSettled(thread.latestTurn, thread.session)) return false;
  if (hasQueuedTurnStart(thread, now)) return false;
  const activityMs = resolveThreadActivityMs(thread);
  const nowMs = Date.parse(now);
  if (activityMs === null || Number.isNaN(nowMs)) return false;
  return nowMs - activityMs > SIDEBAR_SETTLE_AFTER_IDLE_MS;
}

export function resolveSidebarThreadSection(
  thread: SidebarSectionThread,
  now: string,
): SidebarSection {
  const pinned = thread.pinnedAt != null;
  if (threadNeedsUser(thread)) return pinned ? "pinned" : "active";
  if (isThreadSnoozed(thread, now)) return "snoozed";
  if (pinned) return "pinned";
  if (isThreadSettled(thread, now)) return "settled";
  return "active";
}

export interface SidebarThreadSections<T> {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly snoozed: readonly T[];
  readonly settled: readonly T[];
}

/**
 * Assign and order threads. Pinned: most recently pinned first (our existing
 * pin order). Active: threads that need the person first, then the user's
 * sidebar sort order. Snoozed: soonest wake first. Settled: most recent
 * activity first, regardless of sort order (history reads by when work ended).
 */
export function partitionSidebarThreads<T extends SidebarSectionThread>(
  threads: readonly T[],
  input: { readonly now: string; readonly sortOrder: SidebarThreadSortOrder },
): SidebarThreadSections<T> {
  const buckets: Record<SidebarSection, T[]> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };
  for (const thread of threads) {
    buckets[resolveSidebarThreadSection(thread, input.now)].push(thread);
  }
  const activeSorted = sortThreads(buckets.active, input.sortOrder);
  const needsUser = activeSorted.filter(threadNeedsUser);
  const rest = activeSorted.filter((thread) => !threadNeedsUser(thread));
  const wakeMs = (thread: T) =>
    toSortableTimestamp(thread.snoozedUntil ?? undefined) ?? Number.POSITIVE_INFINITY;
  const activityMs = (thread: T) => resolveThreadActivityMs(thread) ?? Number.NEGATIVE_INFINITY;
  return {
    pinned: sortThreadsPinnedFirst(buckets.pinned, input.sortOrder),
    active: [...needsUser, ...rest],
    snoozed: buckets.snoozed.toSorted(
      (left, right) => wakeMs(left) - wakeMs(right) || left.id.localeCompare(right.id),
    ),
    settled: buckets.settled.toSorted(
      (left, right) => activityMs(right) - activityMs(left) || right.id.localeCompare(left.id),
    ),
  };
}

export type SidebarInboxListItem<T> =
  | { readonly kind: "thread"; readonly thread: T; readonly section: SidebarSection }
  | { readonly kind: "snoozed-header"; readonly count: number; readonly expanded: boolean }
  | { readonly kind: "settled-header"; readonly count: number }
  | {
      readonly kind: "settled-toggle";
      readonly hiddenCount: number;
      readonly expanded: boolean;
    };

export interface SidebarInboxLayout<T> {
  readonly sections: SidebarThreadSections<T>;
  /** Rows and section markers in render order. */
  readonly items: readonly SidebarInboxListItem<T>[];
  /** Thread rows actually rendered, in order (keyboard jumps, prewarm). */
  readonly visibleThreads: readonly T[];
  /** Threads tucked away in a collapsed shelf or behind "Show more". */
  readonly hiddenThreads: readonly T[];
}

/**
 * Build one project's list. The snoozed shelf renders collapsed by default;
 * settled rows show the first SIDEBAR_SETTLED_PREVIEW_LIMIT until expanded.
 * `forceVisibleKey` keeps the open chat rendered in its section even when
 * its shelf is collapsed, so the selection never disappears.
 */
export function buildSidebarInboxLayout<T extends SidebarSectionThread>(
  threads: readonly T[],
  input: {
    readonly now: string;
    readonly sortOrder: SidebarThreadSortOrder;
    readonly snoozedExpanded: boolean;
    readonly settledExpanded: boolean;
    readonly threadKey: (thread: T) => string;
    readonly forceVisibleKey?: string | null | undefined;
  },
): SidebarInboxLayout<T> {
  const sections = partitionSidebarThreads(threads, input);
  const items: SidebarInboxListItem<T>[] = [];
  const visibleThreads: T[] = [];
  const hiddenThreads: T[] = [];
  const isForced = (thread: T) =>
    input.forceVisibleKey != null && input.threadKey(thread) === input.forceVisibleKey;
  const pushThread = (thread: T, section: SidebarSection) => {
    items.push({ kind: "thread", thread, section });
    visibleThreads.push(thread);
  };

  for (const thread of sections.pinned) pushThread(thread, "pinned");
  for (const thread of sections.active) pushThread(thread, "active");

  if (sections.snoozed.length > 0) {
    items.push({
      kind: "snoozed-header",
      count: sections.snoozed.length,
      expanded: input.snoozedExpanded,
    });
    for (const thread of sections.snoozed) {
      if (input.snoozedExpanded || isForced(thread)) pushThread(thread, "snoozed");
      else hiddenThreads.push(thread);
    }
  }

  if (sections.settled.length > 0) {
    items.push({ kind: "settled-header", count: sections.settled.length });
    const overflowing = sections.settled.length > SIDEBAR_SETTLED_PREVIEW_LIMIT;
    sections.settled.forEach((thread, index) => {
      if (input.settledExpanded || index < SIDEBAR_SETTLED_PREVIEW_LIMIT || isForced(thread)) {
        pushThread(thread, "settled");
      } else {
        hiddenThreads.push(thread);
      }
    });
    if (overflowing) {
      items.push({
        kind: "settled-toggle",
        hiddenCount: sections.settled.length - SIDEBAR_SETTLED_PREVIEW_LIMIT,
        expanded: input.settledExpanded,
      });
    }
  }

  return { sections, items, visibleThreads, hiddenThreads };
}

/** Flat mode has no sections; pinned rows still read as pinned. */
function flatSection(thread: Pick<SidebarSectionThread, "pinnedAt">): SidebarSection {
  return thread.pinnedAt != null ? "pinned" : "active";
}

export interface SidebarProjectThreadList<T> {
  /** Every thread in display order, including rows tucked away. */
  readonly orderedThreads: readonly T[];
  /** Rows and markers to render. */
  readonly items: readonly SidebarInboxListItem<T>[];
  /** Thread rows actually rendered, in order. */
  readonly renderedThreads: readonly T[];
  /** Threads not rendered (flat "Show more" overflow, collapsed shelves). */
  readonly hiddenThreads: readonly T[];
  /** Flat mode only: the list is longer than the preview limit. */
  readonly hasOverflowingThreads: boolean;
  readonly shouldShowThreadPanel: boolean;
}

/**
 * One project's chat list, shared by the rendered sidebar and the keyboard
 * jump ordering so both agree on which rows exist. With `inboxSections` off
 * this is the historical flat list: pinned first, then the preview limit with
 * "Show more". A collapsed project still shows the open chat.
 */
export function resolveSidebarProjectThreadList<T extends SidebarSectionThread>(input: {
  readonly threads: readonly T[];
  readonly inboxSections: boolean;
  readonly now: string;
  readonly sortOrder: SidebarThreadSortOrder;
  readonly projectExpanded: boolean;
  readonly activeThreadKey: string | null;
  readonly isThreadListExpanded: boolean;
  readonly snoozedExpanded: boolean;
  readonly previewLimit: number;
  readonly threadKey: (thread: T) => string;
}): SidebarProjectThreadList<T> {
  let orderedThreads: readonly T[];
  let items: readonly SidebarInboxListItem<T>[];
  let renderedThreads: readonly T[];
  let hiddenThreads: readonly T[];
  let hasOverflowingThreads = false;

  if (input.inboxSections) {
    const layout = buildSidebarInboxLayout(input.threads, {
      now: input.now,
      sortOrder: input.sortOrder,
      snoozedExpanded: input.snoozedExpanded,
      settledExpanded: input.isThreadListExpanded,
      threadKey: input.threadKey,
      forceVisibleKey: input.activeThreadKey,
    });
    const { sections } = layout;
    orderedThreads = [
      ...sections.pinned,
      ...sections.active,
      ...sections.snoozed,
      ...sections.settled,
    ];
    items = layout.items;
    renderedThreads = layout.visibleThreads;
    hiddenThreads = layout.hiddenThreads;
  } else {
    orderedThreads = sortThreadsPinnedFirst(input.threads, input.sortOrder);
    hasOverflowingThreads = orderedThreads.length > input.previewLimit;
    renderedThreads =
      input.isThreadListExpanded || !hasOverflowingThreads
        ? orderedThreads
        : orderedThreads.slice(0, input.previewLimit);
    hiddenThreads = orderedThreads.slice(renderedThreads.length);
    items = renderedThreads.map((thread) => ({
      kind: "thread" as const,
      thread,
      section: flatSection(thread),
    }));
  }

  if (input.projectExpanded) {
    return {
      orderedThreads,
      items,
      renderedThreads,
      hiddenThreads,
      hasOverflowingThreads,
      shouldShowThreadPanel: true,
    };
  }

  const activeThread =
    input.activeThreadKey === null
      ? undefined
      : orderedThreads.find((thread) => input.threadKey(thread) === input.activeThreadKey);
  if (activeThread === undefined) {
    return {
      orderedThreads,
      items: [],
      renderedThreads: [],
      hiddenThreads: orderedThreads,
      hasOverflowingThreads,
      shouldShowThreadPanel: false,
    };
  }
  const activeItem = items.find(
    (item): item is Extract<SidebarInboxListItem<T>, { kind: "thread" }> =>
      item.kind === "thread" && item.thread === activeThread,
  );
  return {
    orderedThreads,
    items: [
      activeItem ?? { kind: "thread", thread: activeThread, section: flatSection(activeThread) },
    ],
    renderedThreads: [activeThread],
    hiddenThreads: orderedThreads.filter((thread) => thread !== activeThread),
    hasOverflowingThreads,
    shouldShowThreadPanel: true,
  };
}
