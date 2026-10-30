import type { ThreadPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  primaryPullRequest,
  pullRequestBranches,
  pullRequestChecksLabel,
  pullRequestReviewLabel,
  pullRequestStateLabel,
  pullRequestTone,
} from "./ThreadDetails.logic";

type Snapshot = NonNullable<ThreadPullRequest["snapshot"]>;

const link = (
  overrides: Partial<Snapshot> | null,
  linkedAt = "2026-10-30T10:00:00.000Z",
): ThreadPullRequest =>
  ({
    provider: "github",
    repository: "getuno/app",
    number: 12,
    url: "https://github.com/getuno/app/pull/12",
    source: "branch",
    linkedAt,
    snapshot:
      overrides === null
        ? null
        : {
            title: "Fix login",
            state: "open",
            isDraft: false,
            headBranch: "fix/login",
            baseBranch: "main",
            updatedAt: "2026-10-30T10:00:00.000Z",
            mergedAt: null,
            closedAt: null,
            checks: "none",
            review: "none",
            syncedAt: "2026-10-30T10:00:00.000Z",
            ...overrides,
          },
  }) as ThreadPullRequest;

describe("pull request wording", () => {
  it("tells a draft and a link not read yet from an open PR", () => {
    expect(pullRequestStateLabel(link({}))).toBe("Open");
    expect(pullRequestStateLabel(link({ isDraft: true }))).toBe("Draft");
    expect(pullRequestStateLabel(link({ state: "merged" }))).toBe("Merged");
    expect(pullRequestStateLabel(link(null))).toBe("Checking");
    expect(pullRequestTone(link(null))).toBe("unknown");
  });

  it("stays quiet when there are no checks or reviews", () => {
    expect(pullRequestChecksLabel(link({}))).toBeNull();
    expect(pullRequestReviewLabel(link({}))).toBeNull();
    expect(pullRequestChecksLabel(link({ checks: "failing" }))).toBe("Checks failing");
    expect(pullRequestReviewLabel(link({ review: "changes_requested" }))).toBe("Changes requested");
  });

  it("shows branches once read", () => {
    expect(pullRequestBranches(link(null))).toBeNull();
    expect(pullRequestBranches(link({}))).toBe("main ← fix/login");
  });
});

describe("primaryPullRequest", () => {
  it("prefers an open PR over a newer merged one", () => {
    const open = link({}, "2026-10-29T10:00:00.000Z");
    const merged = link({ state: "merged" }, "2026-10-30T10:00:00.000Z");
    expect(primaryPullRequest([merged, open])).toBe(open);
  });

  it("falls back to the newest, and to nothing", () => {
    const older = link({ state: "closed" }, "2026-10-29T10:00:00.000Z");
    const newer = link({ state: "merged" }, "2026-10-30T10:00:00.000Z");
    expect(primaryPullRequest([older, newer])).toBe(newer);
    expect(primaryPullRequest([])).toBeNull();
    expect(primaryPullRequest(undefined)).toBeNull();
  });
});
