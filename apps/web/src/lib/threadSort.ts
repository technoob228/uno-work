import type { ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { Thread } from "../types";

export type ThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
};

export type PinnedSortInput = { pinnedAt?: string | null };

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    return toSortableTimestamp(thread.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

export function sortThreads<T extends Pick<Thread, "id"> & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return threads.toSorted((left, right) => {
    const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
    const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

/**
 * Sidebar thread ordering: pinned threads float to the top, and within each
 * group (pinned / unpinned) the normal `sortThreads` ordering applies. A pin
 * timestamp is used only to keep pin ordering stable among multiple pinned
 * threads (most recently pinned first); it never changes the timestamp-based
 * ordering used everywhere else, so project-representative selection is
 * unaffected (this is a sidebar-only variant).
 */
export function sortThreadsPinnedFirst<
  T extends Pick<Thread, "id"> & ThreadSortInput & PinnedSortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T[] {
  const sorted = sortThreads(threads, sortOrder);
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const thread of sorted) {
    if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else {
      unpinned.push(thread);
    }
  }
  pinned.sort((left, right) => {
    const leftPin = toSortableTimestamp(left.pinnedAt ?? undefined) ?? Number.NEGATIVE_INFINITY;
    const rightPin = toSortableTimestamp(right.pinnedAt ?? undefined) ?? Number.NEGATIVE_INFINITY;
    if (rightPin !== leftPin) return rightPin > leftPin ? 1 : -1;
    return right.id.localeCompare(left.id);
  });
  return [...pinned, ...unpinned];
}

export function getLatestThreadForProject<
  T extends Pick<Thread, "id" | "projectId" | "archivedAt"> & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  );
}
