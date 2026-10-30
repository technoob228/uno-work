/**
 * Which chat copies (git worktrees) may go, and why — the pure half of the
 * worktree cleanup (UNO_FORK.md, "Worktree cleanup").
 *
 * A copy goes when its chat was deleted, when the chat is Done or archived
 * and has been quiet for `worktreeSettledAfterDays`, or when any chat has
 * been quiet for `worktreeAfterDays`. When the disk is nearly full (the same
 * line the Computer page warns at) the limits shrink to 0 and 3 days.
 *
 * "Done" mirrors the sidebar (Sidebar.sections.ts): Done by hand, or a chat
 * whose last turn finished and that has been idle 3 days. The server doesn't
 * see read marks, so a finished chat nobody opened counts as Done here too —
 * its copy comes back on the next message anyway. An open pull request keeps a
 * chat out of the automatic Done here too.
 *
 * @module worktreeCleanup/policy
 */
import type { OrchestrationThreadShell, StorageCleanupSettings } from "@t3tools/contracts";
import { pullRequestHoldsThread } from "@t3tools/shared/threadPullRequests";

import { DISK_TIGHT_FREE_GB, DISK_TIGHT_PCT } from "../computerResources/resourceWarnings.ts";

export const DAY_MS = 86_400_000;
/** Anything the chat did this recently keeps its copy (queued turns, Undo of Done). */
export const ACTIVITY_GRACE_MS = 10 * 60_000;
/** Same as the sidebar's SIDEBAR_SETTLE_AFTER_IDLE_MS. */
export const AUTO_DONE_AFTER_MS = 3 * DAY_MS;
/** A turn still "running" this long after the chat's last activity is a leftover. */
export const STALE_RUNNING_TURN_MS = DAY_MS;
export const LOW_DISK_SETTLED_DAYS = 0;
export const LOW_DISK_IDLE_DAYS = 3;

export type CleanupThread = Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "latestTurn"
  | "createdAt"
  | "archivedAt"
  | "pinnedAt"
  | "settledOverride"
  | "settledAt"
  | "session"
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pullRequests"
>;

export interface CleanupRules {
  readonly onDelete: boolean;
  readonly settledAfterDays: number | null;
  readonly afterDays: number | null;
  readonly saveChanges: boolean;
  /** The short limits apply (disk nearly full and the switch is on). */
  readonly lowDisk: boolean;
}

export interface DiskSpaceReading {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** The Computer page's "disk is getting full" line: 85% used or under 3 GB free. */
export function isLowDisk(space: DiskSpaceReading | null): boolean {
  if (space === null || space.totalBytes <= 0) return false;
  const usedPct = ((space.totalBytes - space.freeBytes) / space.totalBytes) * 100;
  return usedPct >= DISK_TIGHT_PCT || space.freeBytes < DISK_TIGHT_FREE_GB * 1024 ** 3;
}

/** Low disk only shortens limits the person kept on; a rule turned off stays off. */
export function effectiveRules(settings: StorageCleanupSettings, lowDisk: boolean): CleanupRules {
  const tighten = lowDisk && settings.worktreeLowDisk;
  const shorten = (days: number | null, low: number) =>
    days === null ? null : tighten ? Math.min(days, low) : days;
  return {
    onDelete: settings.worktreeOnDelete,
    settledAfterDays: shorten(settings.worktreeSettledAfterDays, LOW_DISK_SETTLED_DAYS),
    afterDays: shorten(settings.worktreeAfterDays, LOW_DISK_IDLE_DAYS),
    saveChanges: settings.worktreeSaveChanges,
    lowDisk: tighten,
  };
}

export function cleanupEnabled(rules: CleanupRules): boolean {
  return rules.onDelete || rules.settledAfterDays !== null || rules.afterDays !== null;
}

function toMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** When the chat last did anything: created, a message, a turn edge. */
export function threadActivityMs(thread: CleanupThread): number {
  let latest = toMs(thread.createdAt) ?? 0;
  for (const value of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    const parsed = toMs(value);
    if (parsed !== null && parsed > latest) latest = parsed;
  }
  return latest;
}

/** Why the chat needs its copy right now; null when it is idle. */
export function threadBusyReason(thread: CleanupThread, now: number): string | null {
  const status = thread.session?.status;
  const activity = threadActivityMs(thread);
  if (
    status === "starting" ||
    status === "running" ||
    thread.session?.activeTurnId != null ||
    (thread.latestTurn?.state === "running" && now - activity < STALE_RUNNING_TURN_MS)
  ) {
    return "The agent is working in this chat";
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "The chat is waiting for your answer";
  }
  const touched = Math.max(activity, toMs(thread.settledAt) ?? 0, toMs(thread.archivedAt) ?? 0);
  if (now - touched < ACTIVITY_GRACE_MS) return "Used a few minutes ago";
  return null;
}

/** Since when the chat counts as Done; null when it isn't. */
export function doneSinceMs(thread: CleanupThread, now: number): number | null {
  const activity = threadActivityMs(thread);
  if (thread.settledOverride === "settled") {
    return Math.max(activity, toMs(thread.settledAt) ?? 0);
  }
  if (thread.settledOverride === "active" || thread.pinnedAt != null) return null;
  // Same as the sidebar: an open PR keeps the chat out of Done.
  if (pullRequestHoldsThread(thread.pullRequests, now)) return null;
  const turn = thread.latestTurn;
  // A chat that never ran a turn never settles (the sidebar's rule too).
  if (turn === null || turn.startedAt == null || turn.completedAt == null) return null;
  if (turn.state === "running") return null;
  return now - activity >= AUTO_DONE_AFTER_MS ? activity : null;
}

function days(ms: number): string {
  const count = Math.max(0, Math.floor(ms / DAY_MS));
  if (count === 0) return "less than a day";
  return count === 1 ? "1 day" : `${count} days`;
}

/** "today" / "3 days ago". */
function since(ms: number): string {
  return ms < DAY_MS ? "today" : `${days(ms)} ago`;
}

export type Verdict =
  | { readonly remove: true; readonly reason: string }
  | { readonly remove: false; readonly reason: string };

/** Whether a live (not deleted) idle chat's copy may go. */
export function liveThreadVerdict(
  thread: CleanupThread,
  rules: CleanupRules,
  now: number,
): Verdict {
  const activity = threadActivityMs(thread);
  const prefix = rules.lowDisk ? "Disk nearly full: " : "";
  const settledLimit = rules.settledAfterDays === null ? null : rules.settledAfterDays * DAY_MS;
  const archivedAt = toMs(thread.archivedAt);
  if (archivedAt !== null && settledLimit !== null) {
    const since = Math.max(activity, archivedAt);
    if (now - since >= settledLimit) {
      return { remove: true, reason: `${prefix}archived chat, quiet for ${days(now - since)}` };
    }
  }
  const doneSince = doneSinceMs(thread, now);
  if (doneSince !== null && settledLimit !== null && now - doneSince >= settledLimit) {
    return { remove: true, reason: `${prefix}Done chat, quiet for ${days(now - activity)}` };
  }
  if (rules.afterDays !== null && now - activity >= rules.afterDays * DAY_MS) {
    return { remove: true, reason: `${prefix}not used for ${days(now - activity)}` };
  }
  if (archivedAt !== null) {
    return { remove: false, reason: `Archived ${since(now - Math.max(activity, archivedAt))}` };
  }
  if (doneSince !== null) return { remove: false, reason: `Done ${since(now - doneSince)}` };
  return { remove: false, reason: `Used ${since(now - activity)}` };
}

export function deletedThreadVerdict(rules: CleanupRules): Verdict {
  return rules.onDelete
    ? { remove: true, reason: "Chat was deleted" }
    : { remove: false, reason: "Chat was deleted; cleanup on delete is off" };
}

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
