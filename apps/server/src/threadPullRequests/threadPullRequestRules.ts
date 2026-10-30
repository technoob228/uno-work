/**
 * The pure half of the PR link (GIT_SYNC_V1, stage 4): how often to ask the
 * host, what a read changes on a thread, and when a thread settles. The rules
 * follow upstream's PullRequestSyncReactor and ThreadSettlementService; the
 * layers around them don't, those are on orchestration v2.
 *
 * Limits are the point of most of this file. GitHub gives a person 5000 points
 * an hour across everything they use it for, and every computer polls on its
 * own.
 *
 * @module threadPullRequests/threadPullRequestRules
 */
import type {
  ChangeRequestStatus,
  SourceControlProviderKind,
  ThreadPullRequest,
} from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SWEEP_INTERVAL_MS = MINUTE_MS;
/** The sweep is a minute apart give or take; this keeps it from skipping a beat. */
const SWEEP_SLACK_MS = 5_000;
/** One nobody touched this long is read on the quiet cadence. */
export const QUIET_AFTER_MS = 30 * MINUTE_MS;
export const QUIET_READ_INTERVAL_MS = 5 * MINUTE_MS;
/** Closed PRs (they can reopen) and branches of chats idle for days. */
export const SLOW_READ_INTERVAL_MS = 15 * MINUTE_MS;
const IDLE_BRANCH_AFTER_MS = 3 * DAY_MS;
/** A turn's end or `gh pr merge` reads at once, but not more than this often. */
export const REQUESTED_READ_GAP_MS = 15_000;
/** A quiet open PR is re-stamped this often, so it keeps holding its thread. */
export const SNAPSHOT_REFRESH_MS = DAY_MS;
/** Below this share of the hourly limit the sweep waits for the reset. */
export const BUDGET_FLOOR = 0.1;
/** After a refusal without a reset time, or a host we can't reach. */
export const PAUSE_AFTER_FAILURE_MS = 15 * MINUTE_MS;

export const MAX_LINKS_PER_THREAD = 8;

export interface SweepThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pullRequests: ReadonlyArray<ThreadPullRequest>;
  readonly settledOverride: "settled" | "active" | null;
  readonly pinnedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly autoSettleDisabledAt: string | null;
  readonly latestPersonMessageAt: string | null;
  readonly latestUserMessageAt: string | null;
}

export const linkKey = (link: { readonly repository: string; readonly number: number }) =>
  `${link.repository.toLowerCase()}#${link.number}`;

export const branchKey = (repository: string, branch: string) =>
  `${repository.toLowerCase()}@${branch}`;

/** `main` has no PR of its own, and asking every minute would be the costliest no. */
export function isBranchWorthAsking(branch: string, defaultBranch: string | null): boolean {
  return branch !== defaultBranch && branch !== "main" && branch !== "master";
}

const msOf = (value: string | null | undefined): number | null => {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export function linkReadInterval(link: ThreadPullRequest, nowMs: number): number | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return 0;
  // Merged is final; the time is what settlement needs, so read until there is one.
  if (snapshot.state === "merged") {
    return snapshot.mergedAt === null ? SLOW_READ_INTERVAL_MS : null;
  }
  if (snapshot.state === "closed") return SLOW_READ_INTERVAL_MS;
  const updatedAtMs = msOf(snapshot.updatedAt);
  const quiet = updatedAtMs !== null && nowMs - updatedAtMs >= QUIET_AFTER_MS;
  return quiet ? QUIET_READ_INTERVAL_MS : SWEEP_INTERVAL_MS;
}

export function branchReadInterval(thread: SweepThread, nowMs: number): number {
  const activityMs = msOf(thread.updatedAt) ?? 0;
  const idle = nowMs - activityMs;
  if (idle < QUIET_AFTER_MS) return SWEEP_INTERVAL_MS;
  return idle < IDLE_BRANCH_AFTER_MS ? QUIET_READ_INTERVAL_MS : SLOW_READ_INTERVAL_MS;
}

/** Due by its cadence; `requested` (a turn's end, `gh pr merge`) goes ahead of it. */
export function isReadDue(input: {
  readonly intervalMs: number | null;
  readonly lastReadMs: number | undefined;
  readonly requested: boolean;
  readonly nowMs: number;
}): boolean {
  const { intervalMs, lastReadMs, requested, nowMs } = input;
  if (lastReadMs === undefined) return intervalMs !== null || requested;
  const sinceRead = nowMs - lastReadMs;
  if (requested) return sinceRead >= REQUESTED_READ_GAP_MS;
  if (intervalMs === null) return false;
  return sinceRead >= intervalMs - SWEEP_SLACK_MS;
}

/** The host's answer that matters for a branch: its open PR, else the newest. */
export function pickBranchPullRequest(
  statuses: ReadonlyArray<ChangeRequestStatus>,
  threadCreatedAt: string,
): ChangeRequestStatus | null {
  const createdMs = msOf(threadCreatedAt) ?? 0;
  const candidates = statuses.filter((status) => {
    if (status.isCrossRepository) return false;
    if (status.state === "open") return true;
    // A PR that ended before this chat began belongs to an earlier use of the branch.
    const endedMs = msOf(status.mergedAt ?? status.closedAt);
    return endedMs === null || endedMs >= createdMs;
  });
  return candidates.find((status) => status.state === "open") ?? candidates[0] ?? null;
}

type Snapshot = NonNullable<ThreadPullRequest["snapshot"]>;
type SnapshotFields = Omit<Snapshot, "syncedAt">;

const snapshotFieldsOf = (status: ChangeRequestStatus): SnapshotFields => ({
  title: status.title,
  state: status.state,
  isDraft: status.isDraft,
  headBranch: status.headRefName,
  baseBranch: status.baseRefName,
  updatedAt: status.updatedAt,
  mergedAt: status.mergedAt,
  closedAt: status.closedAt,
  checks: status.checks,
  review: status.review,
});

function sameSnapshot(left: Snapshot, right: SnapshotFields): boolean {
  return (
    left.title === right.title &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.updatedAt === right.updatedAt &&
    left.mergedAt === right.mergedAt &&
    left.closedAt === right.closedAt &&
    left.checks === right.checks &&
    left.review === right.review
  );
}

export interface LinkRead {
  readonly provider: SourceControlProviderKind;
  readonly repository: string;
  /** Read this sweep by number, keyed by `linkKey`. */
  readonly statuses: ReadonlyMap<string, ChangeRequestStatus>;
  /** This thread's branch was read this sweep: its matches, newest first. */
  readonly branchStatuses: ReadonlyArray<ChangeRequestStatus> | null;
}

/**
 * What a read does to a thread's links. The same list back (`===`) means no
 * event: a PR that didn't move writes nothing, except the daily stamp a quiet
 * open PR needs to keep holding its thread.
 */
export function applyRead(input: {
  readonly thread: SweepThread;
  readonly read: LinkRead;
  readonly now: string;
}): ReadonlyArray<ThreadPullRequest> {
  const { thread, read, now } = input;
  const nowMs = msOf(now) ?? 0;
  let changed = false;

  const refreshed = thread.pullRequests.flatMap((link) => {
    const status = read.statuses.get(linkKey(link));
    if (status === undefined) return [link];
    const fields = snapshotFieldsOf(status);
    const stale =
      link.snapshot === null ||
      !sameSnapshot(link.snapshot, fields) ||
      nowMs - (msOf(link.snapshot.syncedAt) ?? 0) >= SNAPSHOT_REFRESH_MS;
    if (!stale) return [link];
    changed = true;
    return [{ ...link, url: status.url, snapshot: { ...fields, syncedAt: now } }];
  });

  // The thread moved to another branch: a link found by the old one is no longer its work.
  const kept = refreshed.filter((link) => {
    const moved =
      link.source === "branch" &&
      read.branchStatuses !== null &&
      link.snapshot !== null &&
      link.snapshot.headBranch !== thread.branch;
    if (moved) changed = true;
    return !moved;
  });

  const found =
    read.branchStatuses === null
      ? null
      : pickBranchPullRequest(read.branchStatuses, thread.createdAt);
  const known =
    found !== null &&
    kept.some((link) => linkKey(link) === linkKey({ ...read, number: found.number }));
  if (found === null || known) return changed ? kept : thread.pullRequests;

  const added: ThreadPullRequest = {
    provider: read.provider,
    repository: read.repository as ThreadPullRequest["repository"],
    number: found.number,
    url: found.url,
    source: "branch",
    linkedAt: now as ThreadPullRequest["linkedAt"],
    snapshot: { ...snapshotFieldsOf(found), syncedAt: now as Snapshot["syncedAt"] },
  };
  return capLinks([...kept, added]);
}

/** Keeps the list small: finished PRs go first, oldest first. */
export function capLinks(
  links: ReadonlyArray<ThreadPullRequest>,
): ReadonlyArray<ThreadPullRequest> {
  if (links.length <= MAX_LINKS_PER_THREAD) return links;
  const drop = new Set(
    links
      .toSorted(
        (left, right) =>
          Number(left.snapshot?.state === "open") - Number(right.snapshot?.state === "open") ||
          left.linkedAt.localeCompare(right.linkedAt),
      )
      .slice(0, links.length - MAX_LINKS_PER_THREAD),
  );
  return links.filter((link) => !drop.has(link));
}

const terminalAtMs = (link: ThreadPullRequest): number | null => {
  const snapshot = link.snapshot;
  return snapshot === null
    ? null
    : msOf(snapshot.state === "merged" ? snapshot.mergedAt : snapshot.closedAt);
};

/**
 * The links whose outcome the thread waits on. A link made after its PR had
 * already merged records work the thread did, such as merging a PR it was asked
 * to merge, so it can't settle the thread (upstream ca2afd8aea). A PR found by
 * the branch is exempt: the sweep can simply have come late to it.
 */
function awaitedLinks(links: ReadonlyArray<ThreadPullRequest>): ReadonlyArray<ThreadPullRequest> {
  return links.filter((link) => {
    if (link.source === "branch" || link.snapshot === null || link.snapshot.state === "open") {
      return true;
    }
    const linkedAtMs = msOf(link.linkedAt);
    const endedAtMs = terminalAtMs(link);
    return linkedAtMs === null || endedAtMs === null || endedAtMs >= linkedAtMs;
  });
}

/**
 * Does a finished PR settle this thread? The person pulled it back (`active`),
 * pinned it, snoozed it or turned auto-settle off: no. An open PR holds it. A
 * merge older than the person's last message doesn't count either: they came
 * back with more to do (upstream ca2afd8aea). A closed PR settles whatever the
 * switch says, as upstream: the switch is about merges.
 */
export function shouldAutoSettle(input: {
  readonly thread: SweepThread;
  readonly autoSettleOnMerge: boolean;
  readonly nowMs: number;
}): boolean {
  const { thread, autoSettleOnMerge, nowMs } = input;
  if (thread.settledOverride !== null) return false;
  if (thread.pinnedAt !== null || thread.autoSettleDisabledAt !== null) return false;
  const snoozedUntilMs = msOf(thread.snoozedUntil);
  if (snoozedUntilMs !== null && snoozedUntilMs > nowMs) return false;

  const links = awaitedLinks(thread.pullRequests);
  if (links.length === 0) return false;
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return false;

  const latest = links.reduce((current, candidate) =>
    (terminalAtMs(candidate) ?? -1) > (terminalAtMs(current) ?? -1) ? candidate : current,
  );
  const latestAtMs = terminalAtMs(latest);
  if (latestAtMs === null) return false;
  if (latest.snapshot?.state === "merged" && !autoSettleOnMerge) return false;

  const anchorMs = Math.max(
    msOf(thread.createdAt) ?? 0,
    msOf(thread.latestPersonMessageAt ?? thread.latestUserMessageAt) ?? 0,
  );
  return latestAtMs >= anchorMs;
}

export function isRateLimited(detail: string): boolean {
  return /rate limit|secondary limit|abuse|too quickly|\b429\b/iu.test(detail);
}

export type BudgetDecision = { readonly pauseUntilMs: number } | null;

/** Leaves the person's budget to the person: below the floor, wait for the reset. */
export function pauseForBudget(
  budget: {
    readonly remaining: number;
    readonly limit: number;
    readonly resetAt: string | null;
  } | null,
  nowMs: number,
): BudgetDecision {
  if (budget === null || budget.limit <= 0) return null;
  if (budget.remaining >= budget.limit * BUDGET_FLOOR) return null;
  const resetMs = msOf(budget.resetAt);
  return {
    pauseUntilMs: resetMs !== null && resetMs > nowMs ? resetMs : nowMs + PAUSE_AFTER_FAILURE_MS,
  };
}
