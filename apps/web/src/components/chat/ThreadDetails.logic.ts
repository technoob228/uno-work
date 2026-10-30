/**
 * What Dev mode's chat details say about a branch, a copy and its pull
 * requests. Pure, so the wording stays in one tested place.
 */
import type { ThreadPullRequest } from "@t3tools/contracts";

export type PullRequestTone = "open" | "draft" | "merged" | "closed" | "unknown";

export function pullRequestTone(link: ThreadPullRequest): PullRequestTone {
  const snapshot = link.snapshot;
  if (snapshot === null) return "unknown";
  if (snapshot.state === "open") return snapshot.isDraft ? "draft" : "open";
  return snapshot.state;
}

const TONE_LABEL: Record<PullRequestTone, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  unknown: "Checking",
};

export const pullRequestStateLabel = (link: ThreadPullRequest): string =>
  TONE_LABEL[pullRequestTone(link)];

export const PULL_REQUEST_TONE_CLASS: Record<PullRequestTone, string> = {
  open: "text-emerald-600 dark:text-emerald-400",
  draft: "text-muted-foreground",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-rose-600 dark:text-rose-400",
  unknown: "text-muted-foreground",
};

export function pullRequestChecksLabel(link: ThreadPullRequest): string | null {
  switch (link.snapshot?.checks) {
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "pending":
      return "Checks running";
    default:
      return null;
  }
}

export function pullRequestReviewLabel(link: ThreadPullRequest): string | null {
  switch (link.snapshot?.review) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    default:
      return null;
  }
}

/** The one the header shows: an open PR first, else the newest. */
export function primaryPullRequest(
  links: ReadonlyArray<ThreadPullRequest> | null | undefined,
): ThreadPullRequest | null {
  const all = links ?? [];
  if (all.length === 0) return null;
  const byNewest = all.toSorted((a, b) => b.linkedAt.localeCompare(a.linkedAt));
  return byNewest.find((link) => link.snapshot?.state === "open") ?? byNewest[0] ?? null;
}

/** "main ← fix/login"; null until the first read. */
export function pullRequestBranches(link: ThreadPullRequest): string | null {
  const snapshot = link.snapshot;
  return snapshot === null ? null : `${snapshot.baseBranch} ← ${snapshot.headBranch}`;
}
