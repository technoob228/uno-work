/**
 * Recents (and the sidebar's "one list") split by time: Today / Yesterday /
 * This week / Older (T3 port 29.10). Calendar days in the person's own time
 * zone; the week starts on Monday, so on a Monday "This week" is empty and
 * Saturday's chats are under Older — the label means what it says.
 *
 * The list is already sorted newest first, so the groups are contiguous runs;
 * if it isn't (an odd timestamp), a chat still lands in its own group and the
 * groups keep their order, chats inside a group keep theirs.
 */

export type RecentsTimeGroupId = "today" | "yesterday" | "week" | "older";

export const RECENTS_TIME_GROUP_LABELS: Record<RecentsTimeGroupId, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  older: "Older",
};

const GROUP_ORDER: ReadonlyArray<RecentsTimeGroupId> = ["today", "yesterday", "week", "older"];

export interface RecentsTimeGroup<T> {
  readonly id: RecentsTimeGroupId;
  readonly label: string;
  readonly chats: ReadonlyArray<T>;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Which group a moment falls in, seen from `now`. Unknown times are Older. */
export function recentsTimeGroupOf(timeMs: number, now: Date): RecentsTimeGroupId {
  if (!Number.isFinite(timeMs)) return "older";
  const today = startOfLocalDay(now);
  if (timeMs >= today) return "today";
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (timeMs >= yesterdayDate.getTime()) return "yesterday";
  // Monday of this week (getDay: Sunday 0 … Saturday 6).
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
  if (timeMs >= monday.getTime()) return "week";
  return "older";
}

export function groupRecentsByTime<T>(input: {
  readonly chats: ReadonlyArray<T>;
  /** The time the list is sorted by (last message or created). */
  readonly timeOf: (chat: T) => number;
  readonly now: Date;
}): RecentsTimeGroup<T>[] {
  const byGroup = new Map<RecentsTimeGroupId, T[]>();
  for (const chat of input.chats) {
    const id = recentsTimeGroupOf(input.timeOf(chat), input.now);
    const list = byGroup.get(id);
    if (list) list.push(chat);
    else byGroup.set(id, [chat]);
  }
  return GROUP_ORDER.flatMap((id) => {
    const chats = byGroup.get(id);
    return chats ? [{ id, label: RECENTS_TIME_GROUP_LABELS[id], chats }] : [];
  });
}

/**
 * The flat order the rows render in — the sidebar's keyboard order (⌘⇧[ / ⌘⇧])
 * should follow it. Same as the input for a sorted list.
 */
export function flattenRecentsTimeGroups<T>(groups: ReadonlyArray<RecentsTimeGroup<T>>): T[] {
  return groups.flatMap((group) => group.chats);
}
