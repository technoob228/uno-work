import type { ChangeRequestStatus, ThreadPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyRead,
  branchReadInterval,
  capLinks,
  isBranchWorthAsking,
  isRateLimited,
  isReadDue,
  linkKey,
  linkReadInterval,
  MAX_LINKS_PER_THREAD,
  pauseForBudget,
  pickBranchPullRequest,
  QUIET_READ_INTERVAL_MS,
  SLOW_READ_INTERVAL_MS,
  SNAPSHOT_REFRESH_MS,
  shouldAutoSettle,
  SWEEP_INTERVAL_MS,
  type SweepThread,
} from "./threadPullRequestRules.ts";

const NOW = "2026-10-30T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ago = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();

const status = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus =>
  ({
    number: 12,
    title: "Fix login",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    isDraft: false,
    headRefName: "fix/login",
    baseRefName: "main",
    isCrossRepository: false,
    updatedAt: ago(1),
    mergedAt: null,
    closedAt: null,
    checks: "passing",
    review: "none",
    ...overrides,
  }) as ChangeRequestStatus;

const link = (
  snapshot: Partial<NonNullable<ThreadPullRequest["snapshot"]>> | null = {},
  overrides: Partial<ThreadPullRequest> = {},
): ThreadPullRequest =>
  ({
    provider: "github",
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    source: "branch",
    linkedAt: ago(120),
    snapshot:
      snapshot === null
        ? null
        : {
            title: "Fix login",
            state: "open",
            isDraft: false,
            headBranch: "fix/login",
            baseBranch: "main",
            updatedAt: ago(1),
            mergedAt: null,
            closedAt: null,
            checks: "passing",
            review: "none",
            syncedAt: ago(1),
            ...snapshot,
          },
    ...overrides,
  }) as ThreadPullRequest;

const thread = (overrides: Partial<SweepThread> = {}): SweepThread => ({
  threadId: "thread-1",
  projectId: "project-1",
  workspaceRoot: "/work/app",
  branch: "fix/login",
  createdAt: ago(600),
  updatedAt: ago(5),
  pullRequests: [],
  settledOverride: null,
  pinnedAt: null,
  snoozedUntil: null,
  autoSettleDisabledAt: null,
  latestPersonMessageAt: ago(300),
  latestUserMessageAt: ago(300),
  ...overrides,
});

const merged = (minutesAgo: number) => ({
  state: "merged" as const,
  mergedAt: ago(minutesAgo),
});

describe("how often a PR is read", () => {
  it("reads a fresh link at once, a live PR every minute, a quiet one every 5 minutes", () => {
    expect(linkReadInterval(link(null), NOW_MS)).toBe(0);
    expect(linkReadInterval(link({ updatedAt: ago(10) }), NOW_MS)).toBe(SWEEP_INTERVAL_MS);
    expect(linkReadInterval(link({ updatedAt: ago(45) }), NOW_MS)).toBe(QUIET_READ_INTERVAL_MS);
  });

  it("never reads a merged PR again, unless the merge time is missing", () => {
    expect(linkReadInterval(link(merged(1)), NOW_MS)).toBe(null);
    expect(linkReadInterval(link({ state: "merged", mergedAt: null }), NOW_MS)).toBe(
      SLOW_READ_INTERVAL_MS,
    );
  });

  it("reads a closed PR slowly: it can reopen", () => {
    expect(linkReadInterval(link({ state: "closed" }), NOW_MS)).toBe(SLOW_READ_INTERVAL_MS);
  });

  it("asks about a branch by how alive its chat is", () => {
    expect(branchReadInterval(thread({ updatedAt: ago(5) }), NOW_MS)).toBe(SWEEP_INTERVAL_MS);
    expect(branchReadInterval(thread({ updatedAt: ago(120) }), NOW_MS)).toBe(
      QUIET_READ_INTERVAL_MS,
    );
    expect(branchReadInterval(thread({ updatedAt: ago(5_000) }), NOW_MS)).toBe(
      SLOW_READ_INTERVAL_MS,
    );
  });

  it("doesn't ask about the default branch", () => {
    expect(isBranchWorthAsking("main", "main")).toBe(false);
    expect(isBranchWorthAsking("trunk", "trunk")).toBe(false);
    expect(isBranchWorthAsking("master", null)).toBe(false);
    expect(isBranchWorthAsking("fix/login", "main")).toBe(true);
  });

  it("keeps a requested read out of a tight loop", () => {
    const due = (lastSecondsAgo: number) =>
      isReadDue({
        intervalMs: SWEEP_INTERVAL_MS,
        lastReadMs: NOW_MS - lastSecondsAgo * 1_000,
        requested: true,
        nowMs: NOW_MS,
      });
    expect(due(20)).toBe(true);
    expect(due(5)).toBe(false);
  });

  it("reads on the beat of the sweep even when the tick lands a little early", () => {
    expect(
      isReadDue({
        intervalMs: SWEEP_INTERVAL_MS,
        lastReadMs: NOW_MS - 58_000,
        requested: false,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("a merged PR is read only when somebody asks", () => {
    const input = { intervalMs: null, lastReadMs: NOW_MS - 120_000, nowMs: NOW_MS };
    expect(isReadDue({ ...input, requested: false })).toBe(false);
    expect(isReadDue({ ...input, requested: true })).toBe(true);
  });
});

describe("pickBranchPullRequest", () => {
  it("prefers the open one", () => {
    const open = status({ number: 2 });
    expect(
      pickBranchPullRequest([status({ ...merged(10), number: 1 }), open], ago(60))?.number,
    ).toBe(2);
  });

  it("skips a fork's branch of the same name", () => {
    expect(pickBranchPullRequest([status({ isCrossRepository: true })], ago(60))).toBe(null);
  });

  it("skips a PR that ended before the chat began", () => {
    expect(pickBranchPullRequest([status(merged(120))], ago(60))).toBe(null);
    expect(pickBranchPullRequest([status(merged(30))], ago(60))?.number).toBe(12);
  });
});

describe("applyRead", () => {
  const read = (
    statuses: ReadonlyArray<ChangeRequestStatus> = [],
    branchStatuses: ReadonlyArray<ChangeRequestStatus> | null = null,
  ) => ({
    provider: "github" as const,
    repository: "acme/app",
    statuses: new Map(
      statuses.map((value) => [linkKey({ repository: "acme/app", ...value }), value]),
    ),
    branchStatuses,
  });

  it("returns the same list when nothing moved, so no event goes out", () => {
    const pullRequests = [link()];
    const current = thread({ pullRequests });
    expect(applyRead({ thread: current, read: read([status()]), now: NOW })).toBe(pullRequests);
  });

  it("stamps a quiet open PR once a day so it keeps holding the thread", () => {
    const synced = new Date(NOW_MS - SNAPSHOT_REFRESH_MS).toISOString();
    const pullRequests = [link({ syncedAt: synced })];
    const next = applyRead({ thread: thread({ pullRequests }), read: read([status()]), now: NOW });
    expect(next).not.toBe(pullRequests);
    expect(next[0]?.snapshot?.syncedAt).toBe(NOW);
  });

  it("carries what changed", () => {
    const next = applyRead({
      thread: thread({ pullRequests: [link()] }),
      read: read([status({ ...merged(1), checks: "failing" })]),
      now: NOW,
    });
    expect(next[0]?.snapshot).toMatchObject({ state: "merged", checks: "failing", syncedAt: NOW });
  });

  it("links the PR found by the branch", () => {
    const next = applyRead({
      thread: thread(),
      read: read([], [status()]),
      now: NOW,
    });
    expect(next).toMatchObject([
      { number: 12, source: "branch", linkedAt: NOW, snapshot: { state: "open" } },
    ]);
  });

  it("doesn't link twice", () => {
    const pullRequests = [link()];
    expect(
      applyRead({ thread: thread({ pullRequests }), read: read([], [status()]), now: NOW }),
    ).toBe(pullRequests);
  });

  it("drops a branch link once the thread moved to another branch", () => {
    const next = applyRead({
      thread: thread({ branch: "feat/other", pullRequests: [link()] }),
      read: read([], []),
      now: NOW,
    });
    expect(next).toEqual([]);
  });

  it("keeps a link the agent created, whatever the branch", () => {
    const created = link({}, { source: "created" });
    const next = applyRead({
      thread: thread({ branch: "feat/other", pullRequests: [created] }),
      read: read([], []),
      now: NOW,
    });
    expect(next).toEqual([created]);
  });
});

describe("capLinks", () => {
  it("lets finished PRs go first", () => {
    const links = Array.from({ length: MAX_LINKS_PER_THREAD + 1 }, (_, index) =>
      link(index === 0 ? { state: "open" } : merged(index), {
        number: index + 1,
        linkedAt: ago(100 - index),
      } as Partial<ThreadPullRequest>),
    );
    const kept = capLinks(links);
    expect(kept).toHaveLength(MAX_LINKS_PER_THREAD);
    expect(kept.map((entry) => entry.number)).toContain(1);
    expect(kept.map((entry) => entry.number)).not.toContain(2);
  });
});

describe("shouldAutoSettle", () => {
  const settles = (overrides: Partial<SweepThread>, autoSettleOnMerge = true) =>
    shouldAutoSettle({ thread: thread(overrides), autoSettleOnMerge, nowMs: NOW_MS });

  it("settles after a merge later than the person's last message", () => {
    expect(settles({ pullRequests: [link(merged(10))] })).toBe(true);
  });

  it("doesn't settle when the person wrote after the merge", () => {
    expect(settles({ pullRequests: [link(merged(10))], latestPersonMessageAt: ago(5) })).toBe(
      false,
    );
  });

  it("an agent's message after the merge doesn't count as the person's", () => {
    expect(
      settles({
        pullRequests: [link(merged(10))],
        latestPersonMessageAt: ago(300),
        latestUserMessageAt: ago(5),
      }),
    ).toBe(true);
  });

  it("an open PR holds the thread", () => {
    expect(
      settles({
        pullRequests: [link(merged(10)), link({ state: "open" }, { number: 13 } as never)],
      }),
    ).toBe(false);
  });

  it("waits for a link that hasn't been read yet", () => {
    expect(settles({ pullRequests: [link(merged(10)), link(null, { number: 13 } as never)] })).toBe(
      false,
    );
  });

  it("respects the switch, the pin, the snooze and the person's override", () => {
    const pullRequests = [link(merged(10))];
    expect(settles({ pullRequests }, false)).toBe(false);
    expect(settles({ pullRequests, pinnedAt: ago(1) })).toBe(false);
    expect(settles({ pullRequests, autoSettleDisabledAt: ago(1) })).toBe(false);
    expect(settles({ pullRequests, settledOverride: "active" })).toBe(false);
    expect(settles({ pullRequests, snoozedUntil: ago(-60) })).toBe(false);
  });

  it("a snooze that ran out no longer holds", () => {
    expect(settles({ pullRequests: [link(merged(10))], snoozedUntil: ago(1) })).toBe(true);
  });

  it("a closed PR settles even with the merge switch off", () => {
    const pullRequests = [link({ state: "closed", closedAt: ago(10) })];
    expect(settles({ pullRequests }, false)).toBe(true);
  });

  it("a PR linked after it merged records done work and doesn't settle", () => {
    const created = link(merged(30), { source: "created", linkedAt: ago(10) });
    expect(settles({ pullRequests: [created] })).toBe(false);
  });

  it("a PR the sweep found late still settles: it was the thread's own branch", () => {
    const found = link(merged(30), { source: "branch", linkedAt: ago(10) });
    expect(settles({ pullRequests: [found] })).toBe(true);
  });

  it("a chat without a person's message counts from when it began", () => {
    expect(
      settles({
        pullRequests: [link(merged(10))],
        latestPersonMessageAt: null,
        latestUserMessageAt: null,
      }),
    ).toBe(true);
  });

  it("nothing to wait on, nothing to settle", () => {
    expect(settles({ pullRequests: [] })).toBe(false);
  });
});

describe("limits", () => {
  it("leaves the last tenth of the budget to the person, until the reset", () => {
    const resetAt = ago(-30);
    expect(pauseForBudget({ remaining: 400, limit: 5000, resetAt }, NOW_MS)).toEqual({
      pauseUntilMs: Date.parse(resetAt),
    });
    expect(pauseForBudget({ remaining: 600, limit: 5000, resetAt }, NOW_MS)).toBe(null);
    expect(pauseForBudget(null, NOW_MS)).toBe(null);
  });

  it("knows a refusal for limits when it reads one", () => {
    expect(isRateLimited("API rate limit exceeded for user")).toBe(true);
    expect(isRateLimited("You have exceeded a secondary rate limit")).toBe(true);
    expect(isRateLimited("HTTP 429")).toBe(true);
    expect(isRateLimited("Not Found")).toBe(false);
  });
});
