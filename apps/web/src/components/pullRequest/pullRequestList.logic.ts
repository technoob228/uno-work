/**
 * Sorting and grouping for the Pull requests page. The rules are upstream's
 * `pullRequest/pullRequestList.logic.ts`, kept as they are; only the parts the
 * page shows came over.
 */
import type {
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListResult,
  PullRequestListState,
} from "@t3tools/contracts";

export type PullRequestListSort = "ready" | "blocked" | "updated" | "newest" | "largest";

export const SORT_LABELS: Record<PullRequestListSort, string> = {
  ready: "Merge readiness",
  blocked: "Blocked on me",
  updated: "Recently updated",
  newest: "Newest",
  largest: "Largest",
};

export interface EnvironmentPullRequestEntry extends PullRequestListEntry {
  readonly environmentId: string;
}

export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup<Entry extends PullRequestListEntry = PullRequestListEntry> {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

export type PullRequestViewers = PullRequestListResult["viewers"];

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function pullRequestEntryKey(entry: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${entry.host}:${entry.repository.toLowerCase()}#${entry.number}`;
}

function isAuthoredByViewer(entry: PullRequestListEntry, viewers: PullRequestViewers): boolean {
  const viewer = normalize(viewers[entry.host]);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

export function matchesPullRequestQuery(entry: PullRequestListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function filterPullRequestsByInvolvement<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<Entry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  }
  return entries;
}

export function groupPullRequestsByInvolvement<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const buckets: Record<PullRequestGroupKey, Entry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

const timestampOf = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export function comparePullRequestsByRecency(
  left: PullRequestListEntry,
  right: PullRequestListEntry,
) {
  const leftUpdated = timestampOf(left.updatedAt);
  const rightUpdated = timestampOf(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

export function rankPullRequestsByMergeReadiness<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const tier = (entry: Entry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const hasSize = (entry: Entry) => entry.additions + entry.deletions > 0;
    const measured = Number(hasSize(right)) - Number(hasSize(left));
    const sized = left.additions + left.deletions - (right.additions + right.deletions);
    return measured || sized || comparePullRequestsByRecency(left, right);
  });
}

function rankByTierThenRecency<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  tier: (entry: Entry) => number,
): ReadonlyArray<Entry> {
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    return byTier !== 0 ? byTier : comparePullRequestsByRecency(left, right);
  });
}

export function rankPullRequestsBlockedOnAuthor<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved") return 5;
    return 4;
  });
}

function rankPullRequestsBlockedOnReviewer<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => (entry.state === "open" ? 0 : 1));
}

export function sortPullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  sort: PullRequestListSort,
  searchText: string,
  involvement: PullRequestInvolvement = "all",
): ReadonlyArray<PullRequestGroup<Entry>> {
  const sortWithinGroups = (rank: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>) =>
    groups.map((group) => ({ ...group, entries: rank(group.entries) }));

  if (sort === "ready") {
    return searchText.trim().length === 0
      ? sortWithinGroups(rankPullRequestsByMergeReadiness)
      : groups;
  }
  if (sort === "blocked") {
    if (searchText.trim().length > 0) return groups;
    const role = (key: PullRequestGroupKey) =>
      key === "others" ? involvement : key === "authored" ? "authored" : "reviewing";
    return groups.map((group) => {
      const groupRole = role(group.key);
      if (groupRole === "all") return group;
      const rank =
        groupRole === "authored"
          ? rankPullRequestsBlockedOnAuthor
          : rankPullRequestsBlockedOnReviewer;
      return { ...group, entries: rank(group.entries) };
    });
  }
  if (sort === "updated") return groups;
  return sortWithinGroups((entries) =>
    entries.toSorted((left, right) => {
      if (sort === "newest") {
        return (timestampOf(right.createdAt) ?? 0) - (timestampOf(left.createdAt) ?? 0);
      }
      const size = (entry: Entry) => entry.additions + entry.deletions;
      return size(right) - size(left) || comparePullRequestsByRecency(left, right);
    }),
  );
}

/** One line of what stands between a pull request and its merge, or null when nothing does. */
export function pullRequestBlocker(entry: {
  readonly state: PullRequestListEntry["state"];
  readonly isDraft: boolean;
  readonly mergeability: PullRequestListEntry["mergeability"];
  readonly reviewDecision?: PullRequestListEntry["reviewDecision"];
  readonly checksState?: PullRequestListEntry["checksState"];
}): string | null {
  if (entry.state !== "open") return null;
  if (entry.mergeability === "conflicting") return "Conflicts";
  if (entry.isDraft) return "Draft";
  if (entry.checksState === "failing") return "Checks failed";
  if (entry.reviewDecision === "changes-requested") return "Changes requested";
  if (entry.checksState === "pending") return "Checks running";
  if (entry.reviewDecision === "review-required") return "Needs review";
  return null;
}

/** What this pull request offers now, from what its host can do at all. */
export function pullRequestActionsFor(
  entry: {
    readonly state: PullRequestListEntry["state"];
    readonly isDraft: boolean;
  },
  hostActions: ReadonlyArray<PullRequestAction>,
  autoMergeEnabled?: boolean,
): ReadonlyArray<PullRequestAction> {
  const forState: ReadonlyArray<PullRequestAction> =
    entry.state === "merged"
      ? ["revert"]
      : entry.state === "closed"
        ? ["reopen"]
        : entry.isDraft
          ? ["ready", "close"]
          : [
              "merge",
              autoMergeEnabled === true ? "disable-auto-merge" : "enable-auto-merge",
              "approve",
              "close",
            ];
  return forState.filter((action) => hostActions.includes(action));
}

/** The page's rows: one per pull request, however many computers see it. */
export function mergePullRequestLists(
  lists: ReadonlyArray<{ readonly environmentId: string; readonly data: PullRequestListResult }>,
): {
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  readonly viewers: PullRequestViewers;
  readonly providers: PullRequestListResult["providers"];
  readonly truncated: boolean;
} {
  const entries = new Map<string, EnvironmentPullRequestEntry>();
  const viewers: Record<string, string> = {};
  const providers = new Map<string, PullRequestListResult["providers"][number]>();
  let truncated = false;
  for (const { environmentId, data } of lists) {
    truncated = truncated || data.truncated;
    Object.assign(viewers, data.viewers);
    for (const provider of data.providers) {
      const key = `${provider.kind}:${provider.host}`;
      const held = providers.get(key);
      if (held === undefined || (!held.configured && provider.configured)) {
        providers.set(key, provider);
      }
    }
    for (const entry of data.entries) {
      const key = pullRequestEntryKey(entry);
      if (!entries.has(key)) entries.set(key, { ...entry, environmentId });
    }
  }
  return { entries: [...entries.values()], viewers, providers: [...providers.values()], truncated };
}

export const LIST_STATES: ReadonlyArray<{
  readonly value: PullRequestListState;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export const INVOLVEMENTS: ReadonlyArray<{
  readonly value: PullRequestInvolvement;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "authored", label: "Authored" },
  { value: "reviewing", label: "Reviewing" },
];
