import type { PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  mergePullRequestLists,
  pullRequestActionsFor,
  pullRequestBlocker,
  rankPullRequestsBlockedOnAuthor,
  rankPullRequestsByMergeReadiness,
  sortPullRequestGroups,
} from "./pullRequestList.logic";

const entry = (number: number, overrides: Partial<PullRequestListEntry> = {}) =>
  ({
    provider: "github",
    host: "github.com",
    projectId: "p",
    projectTitle: "Stand",
    repository: "acme/stand",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/stand/pull/${number}`,
    author: { login: "me", name: null, avatarUrl: null },
    headBranch: `b${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  }) as PullRequestListEntry;

const numbers = (entries: ReadonlyArray<PullRequestListEntry>) => entries.map((e) => e.number);

describe("merge readiness", () => {
  it("puts approved and green first, conflicts last", () => {
    const ranked = rankPullRequestsByMergeReadiness([
      entry(1, { mergeability: "conflicting" }),
      entry(2, { checksState: "passing" }),
      entry(3, { checksState: "passing", reviewDecision: "approved" }),
      entry(4, { isDraft: true }),
    ]);
    expect(numbers(ranked)).toEqual([3, 2, 4, 1]);
  });

  it("prefers the smaller of two equally ready", () => {
    const ranked = rankPullRequestsByMergeReadiness([
      entry(1, { checksState: "passing", additions: 50 }),
      entry(2, { checksState: "passing", additions: 5 }),
    ]);
    expect(numbers(ranked)).toEqual([2, 1]);
  });
});

describe("blocked on me", () => {
  it("as the author: conflicts, change requests, then failures", () => {
    const ranked = rankPullRequestsBlockedOnAuthor([
      entry(1, { checksState: "failing" }),
      entry(2, { reviewDecision: "changes-requested" }),
      entry(3, { mergeability: "conflicting" }),
      entry(4, { checksState: "passing", reviewDecision: "approved" }),
    ]);
    expect(numbers(ranked)).toEqual([3, 2, 1, 4]);
  });

  it("leaves other people's pull requests alone under All", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry(1, { author: { login: "ann", name: null, avatarUrl: null } }),
        entry(2, {
          author: { login: "ann", name: null, avatarUrl: null },
          mergeability: "conflicting",
        }),
      ],
      { "github.com": "me" },
    );
    const sorted = sortPullRequestGroups(groups, "blocked", "", "all");
    expect(numbers(sorted[0]!.entries)).toEqual([1, 2]);
  });
});

describe("involvement", () => {
  it("splits authored from reviewing and others", () => {
    const list = [
      entry(1),
      entry(2, { author: null, viewerReviewRequested: true }),
      entry(3, { author: null }),
    ];
    const viewers = { "github.com": "ME" };
    expect(groupPullRequestsByInvolvement(list, viewers).map((g) => g.key)).toEqual([
      "authored",
      "reviewRequested",
      "others",
    ]);
    expect(numbers(filterPullRequestsByInvolvement(list, viewers, "authored"))).toEqual([1]);
    expect(numbers(filterPullRequestsByInvolvement(list, viewers, "reviewing"))).toEqual([2]);
  });
});

describe("actions", () => {
  const all = [
    "merge",
    "enable-auto-merge",
    "disable-auto-merge",
    "approve",
    "ready",
    "close",
    "reopen",
    "revert",
  ] as const;

  it("follows the state", () => {
    expect(pullRequestActionsFor({ state: "merged", isDraft: false }, all)).toEqual(["revert"]);
    expect(pullRequestActionsFor({ state: "closed", isDraft: false }, all)).toEqual(["reopen"]);
    expect(pullRequestActionsFor({ state: "open", isDraft: true }, all)).toEqual([
      "ready",
      "close",
    ]);
  });

  it("offers only what the host has", () => {
    expect(pullRequestActionsFor({ state: "open", isDraft: false }, ["merge", "close"])).toEqual([
      "merge",
      "close",
    ]);
    expect(pullRequestActionsFor({ state: "merged", isDraft: false }, ["merge"])).toEqual([]);
  });

  it("swaps auto-merge once it is on", () => {
    expect(pullRequestActionsFor({ state: "open", isDraft: false }, all, true)).toContain(
      "disable-auto-merge",
    );
  });
});

describe("blocker line", () => {
  it("says the first thing in the way", () => {
    expect(pullRequestBlocker(entry(1, { mergeability: "conflicting", isDraft: true }))).toBe(
      "Conflicts",
    );
    expect(pullRequestBlocker(entry(1, { checksState: "failing" }))).toBe("Checks failed");
    expect(pullRequestBlocker(entry(1, { state: "merged" }))).toBeNull();
    expect(pullRequestBlocker(entry(1, { checksState: "passing" }))).toBeNull();
  });
});

describe("two computers", () => {
  it("shows a pull request once, and a host connected on either as connected", () => {
    const provider = {
      host: "github.com",
      kind: "github",
      label: "GitHub",
      projectCount: 1,
      detail: "x",
      capabilities: {
        actions: [],
        mergeMethods: [],
        diff: true,
        comment: true,
        viewedFiles: true,
        mergeMessageRewrite: true,
        deleteBranch: true,
      },
    } as const;
    const merged = mergePullRequestLists([
      {
        environmentId: "a",
        data: {
          viewers: {},
          providers: [{ ...provider, configured: false }] as never,
          entries: [entry(1)],
          truncated: false,
        },
      },
      {
        environmentId: "b",
        data: {
          viewers: { "github.com": "me" },
          providers: [{ ...provider, configured: true }] as never,
          entries: [entry(1), entry(2)],
          truncated: true,
        },
      },
    ]);
    expect(merged.entries.map((e) => `${e.environmentId}${e.number}`)).toEqual(["a1", "b2"]);
    expect(merged.providers[0]?.configured).toBe(true);
    expect(merged.truncated).toBe(true);
  });
});
