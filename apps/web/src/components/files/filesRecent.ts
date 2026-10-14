/**
 * Files → Recent, the pure part of the list: grouping by day, the folder
 * line and the "where it came from" line of a row.
 */
import type { FilesRecentItem } from "@t3tools/contracts";

import { dirname } from "./fileTypes";

export type RecentFilter = "all" | "opened" | "agent";

export interface RecentGroup {
  readonly label: string;
  readonly items: ReadonlyArray<FilesRecentItem>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Today / Yesterday / Earlier, in the order given (newest first). */
export function groupRecentByDay(
  items: ReadonlyArray<FilesRecentItem>,
  now = new Date(),
): RecentGroup[] {
  const today = startOfDay(now);
  const buckets = new Map<string, FilesRecentItem[]>();
  for (const item of items) {
    const time = Date.parse(item.at);
    const label = Number.isNaN(time)
      ? "Earlier"
      : time >= today
        ? "Today"
        : time >= today - DAY_MS
          ? "Yesterday"
          : "Earlier";
    const bucket = buckets.get(label) ?? [];
    bucket.push(item);
    buckets.set(label, bucket);
  }
  return ["Today", "Yesterday", "Earlier"].flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket ? [{ label, items: bucket }] : [];
  });
}

export function filterRecent(
  items: ReadonlyArray<FilesRecentItem>,
  filter: RecentFilter,
): ReadonlyArray<FilesRecentItem> {
  return filter === "all" ? items : items.filter((item) => item.source === filter);
}

/** The folder holding the file, from the home folder: `Home › project › docs`. */
export function recentFolderLabel(rootPath: string | null, path: string): string {
  const folder = dirname(path);
  const root = rootPath?.replace(/\/+$/, "") ?? null;
  if (root === null) return folder;
  if (folder === root) return "Home";
  if (!folder.startsWith(`${root}/`)) return folder;
  return ["Home", ...folder.slice(root.length + 1).split("/")].join(" › ");
}

/** "Opened" or "Changed by <chat>". */
export function recentSourceLabel(item: Pick<FilesRecentItem, "source" | "threadTitle">): string {
  if (item.source === "opened") return "Opened";
  const title = item.threadTitle?.trim();
  return title ? `Changed by ${title}` : "Changed by an agent";
}
