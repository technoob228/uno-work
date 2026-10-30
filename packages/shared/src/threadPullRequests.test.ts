import type { ThreadPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { PULL_REQUEST_HOLD_MAX_AGE_MS, pullRequestHoldsThread } from "./threadPullRequests.ts";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");

const link = (state: "open" | "merged" | "closed", syncedAtMs: number): ThreadPullRequest =>
  ({
    provider: "github",
    repository: "acme/app",
    number: 1,
    url: "https://github.com/acme/app/pull/1",
    source: "branch",
    linkedAt: "2026-10-01T00:00:00.000Z",
    snapshot: {
      title: "Fix",
      state,
      isDraft: false,
      headBranch: "fix",
      baseBranch: "main",
      updatedAt: null,
      mergedAt: null,
      closedAt: null,
      checks: "none",
      review: "none",
      syncedAt: new Date(syncedAtMs).toISOString(),
    },
  }) as ThreadPullRequest;

describe("pullRequestHoldsThread", () => {
  it("holds on a fresh open PR", () => {
    expect(pullRequestHoldsThread([link("open", NOW - 1_000)], NOW)).toBe(true);
  });

  it("does not hold on a finished PR, no PR, or a link never read", () => {
    expect(pullRequestHoldsThread([link("merged", NOW)], NOW)).toBe(false);
    expect(pullRequestHoldsThread([], NOW)).toBe(false);
    expect(pullRequestHoldsThread(null, NOW)).toBe(false);
    expect(pullRequestHoldsThread([{ ...link("open", NOW), snapshot: null }], NOW)).toBe(false);
  });

  it("lets go of a state nobody has checked for two weeks", () => {
    expect(pullRequestHoldsThread([link("open", NOW - PULL_REQUEST_HOLD_MAX_AGE_MS)], NOW)).toBe(
      false,
    );
  });
});
