import { describe, expect, it } from "vitest";

import { hostErrorLine, toPullRequestError } from "./PullRequestService.ts";

describe("errors for the person", () => {
  it("tells a missing tool from a missing sign-in", () => {
    expect(
      toPullRequestError("GitHub", {
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
      }),
    ).toMatchObject({ reason: "not-connected", detail: expect.stringContaining("command-line") });
    expect(
      toPullRequestError("GitHub", {
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
      }),
    ).toMatchObject({ reason: "not-connected", detail: expect.stringContaining("signed in") });
  });

  it("says when something is gone", () => {
    expect(
      toPullRequestError("GitHub", {
        detail: "Error: gh: Could not resolve to a PullRequest with the number of 2.",
      }).reason,
    ).toBe("not-found");
  });

  it("keeps the host's reason, without the plumbing", () => {
    expect(
      hostErrorLine(
        "VcsProcessExitError\nError: failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)\n",
      ),
    ).toBe("Review Can not approve your own pull request");
  });

  it("never repeats a token", () => {
    expect(hostErrorLine("bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
  });

  it("stays one short line", () => {
    expect(hostErrorLine("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});
