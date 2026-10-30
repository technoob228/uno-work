/**
 * What a thread's pull requests mean for the thread, shared by the sidebar and
 * the daemon so both agree on when an open PR keeps a chat out of Done.
 */
import type { ThreadPullRequest } from "@t3tools/contracts";

const DAY_MS = 86_400_000;

/**
 * A link read this long ago no longer holds the thread: Dev mode was turned off
 * or the host stopped answering, and a chat must not stay active for ever on a
 * state nobody checks. The daemon re-stamps a quiet open PR once a day.
 */
export const PULL_REQUEST_HOLD_MAX_AGE_MS = 14 * DAY_MS;

/** An open PR is unfinished work however long the chat has been quiet. */
export function pullRequestHoldsThread(
  pullRequests: ReadonlyArray<ThreadPullRequest> | null | undefined,
  nowMs: number,
): boolean {
  return (pullRequests ?? []).some((link) => {
    if (link.snapshot?.state !== "open") return false;
    const syncedAtMs = Date.parse(link.snapshot.syncedAt);
    return !Number.isNaN(syncedAtMs) && nowMs - syncedAtMs < PULL_REQUEST_HOLD_MAX_AGE_MS;
  });
}
