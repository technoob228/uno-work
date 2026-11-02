import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildSearchQueries,
  GITHUB_PULL_REQUEST_CAPABILITIES,
  makeGitHubPullRequestHost,
  parseDetail,
  parseFilesPage,
  parseListRow,
} from "./gitHubPullRequestHost.ts";
import { isCommitSha, isRepositoryName } from "./pullRequestHost.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Add coffee",
  url: "https://github.com/acme/stand/pull/7",
  author: { login: "ann", avatarUrl: "a", __typename: "User", name: "Ann" },
  headRefName: "coffee",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "CONFLICTING",
  reviewDecision: "CHANGES_REQUESTED",
  additions: 3,
  deletions: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T01:00:00Z",
  repository: { nameWithOwner: "acme/stand" },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "Me" } }] },
  labels: { nodes: [{ name: "menu", color: "ff0000" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...overrides,
});

describe("list rows", () => {
  it("reads a row", () => {
    expect(parseListRow(row(), "github.com", "me")).toMatchObject({
      provider: "github",
      host: "github.com",
      repository: "acme/stand",
      state: "open",
      mergeability: "conflicting",
      reviewDecision: "changes-requested",
      checksState: "failing",
      viewerReviewRequested: true,
      labels: [{ name: "menu", color: "ff0000" }],
    });
  });

  it("leaves out what the host doesn't say", () => {
    const parsed = parseListRow(
      row({ reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
      "github.com",
      null,
    );
    expect(parsed).not.toHaveProperty("reviewDecision");
    expect(parsed).not.toHaveProperty("checksState");
    expect(parsed?.viewerReviewRequested).toBe(false);
  });

  it("drops a row without its essentials", () => {
    expect(parseListRow(row({ title: "" }), "github.com", "me")).toBeNull();
  });

  it("marks a bot as a bot", () => {
    const parsed = parseListRow(
      row({ author: { login: "dependabot", __typename: "Bot" } }),
      "github.com",
      "me",
    );
    expect(parsed?.author).toMatchObject({ login: "dependabot", isBot: true });
  });
});

describe("search queries", () => {
  it("states the filters", () => {
    const { queries } = buildSearchQueries({
      repositories: ["acme/a"],
      state: "closed",
      involvement: "authored",
    });
    expect(queries[0]).toContain("is:closed is:unmerged author:@me");
    expect(queries[0]).toContain("repo:acme/a");
  });

  it("splits past GitHub's 256 characters and says when it had to cut", () => {
    const repositories = Array.from({ length: 200 }, (_, i) => `acme/some-long-repository-${i}`);
    const { queries, cut } = buildSearchQueries({
      repositories,
      state: "open",
      involvement: "all",
    });
    expect(queries.every((query) => query.length <= 256)).toBe(true);
    expect(queries).toHaveLength(6);
    expect(cut).toBe(true);
  });

  it("asks nothing with no repositories", () => {
    expect(
      buildSearchQueries({ repositories: [], state: "open", involvement: "all" }).queries,
    ).toEqual([]);
  });
});

describe("detail", () => {
  const repository = {
    mergeCommitAllowed: false,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    pullRequest: {
      ...row(),
      id: "PR_1",
      body: "Why",
      changedFiles: 2,
      headRefOid: "abc1234",
      mergedAt: null,
      closedAt: null,
      autoMergeRequest: { mergeMethod: "SQUASH" },
      comments: {
        nodes: [
          {
            id: "c1",
            body: "First",
            createdAt: "2026-11-01T02:00:00Z",
            lastEditedAt: null,
            url: "u",
            author: { login: "ann" },
          },
        ],
      },
      reviews: {
        nodes: [
          {
            id: "r1",
            body: "",
            state: "COMMENTED",
            submittedAt: "2026-11-01T03:00:00Z",
            url: "u",
            author: { login: "bob" },
            comments: {
              nodes: [
                {
                  id: "rc1",
                  body: "Rename",
                  path: "a.ts",
                  createdAt: "2026-11-01T03:00:00Z",
                  url: "u",
                  author: { login: "bob" },
                },
              ],
            },
          },
          {
            id: "r2",
            body: "",
            state: "APPROVED",
            submittedAt: "2026-11-01T04:00:00Z",
            url: "u",
            author: { login: "cat" },
            comments: { nodes: [] },
          },
          {
            id: "pending",
            body: "unsent",
            state: "PENDING",
            submittedAt: null,
            comments: { nodes: [] },
          },
        ],
      },
      allCommits: {
        nodes: [
          {
            commit: {
              oid: "abc1234",
              messageHeadline: "Add coffee",
              committedDate: "2026-11-01T00:00:00Z",
              url: "u",
              authors: { nodes: [{ name: "Ann", user: { login: "ann", avatarUrl: null } }] },
            },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "unit",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://ci/1",
                      isRequired: true,
                      checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                    },
                    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS" },
                    {
                      __typename: "StatusContext",
                      context: "deploy",
                      state: "SUCCESS",
                      targetUrl: "https://d",
                      description: "ok",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };

  const parsed = parseDetail(repository, "me", "github.com", "acme/stand");

  it("reads checks in order, with their workflow's name", () => {
    expect(parsed?.checks.map((check) => [check.name, check.status, check.required])).toEqual([
      ["CI / unit", "failure", true],
      ["lint", "pending", undefined],
      ["deploy", "success", undefined],
    ]);
  });

  it("keeps real comments and leaves out unsent reviews and empty frames", () => {
    expect(parsed?.comments.map((comment) => [comment.id, comment.kind])).toEqual([
      ["c1", "issue-comment"],
      ["rc1", "review-comment"],
      ["r2", "review"],
    ]);
    expect(parsed?.comments.at(-1)?.reviewState).toBe("approved");
  });

  it("offers the merge methods the repository allows", () => {
    expect(parsed?.mergeMethods).toEqual(["squash", "rebase"]);
    expect(parsed?.autoMergeEnabled).toBe(true);
  });
});

describe("files", () => {
  it("maps viewed marks, a mark on an outdated file reads as changed", () => {
    const page = parseFilesPage({
      pullRequest: {
        files: {
          pageInfo: { hasNextPage: true, endCursor: "next" },
          nodes: [
            { path: "a", additions: 1, deletions: 0, viewerViewedState: "VIEWED" },
            { path: "b", additions: 0, deletions: 1, viewerViewedState: "DISMISSED" },
            { path: "c", additions: 0, deletions: 0, viewerViewedState: "UNVIEWED" },
          ],
        },
      },
    });
    expect(page.files.map((file) => file.viewed)).toEqual(["viewed", "changed", "unviewed"]);
    expect(page.nextCursor).toBe("next");
  });
});

describe("actions", () => {
  const harness = (replies: (args: ReadonlyArray<string>) => string = () => "{}") => {
    const calls: Array<ReadonlyArray<string>> = [];
    const github = {
      execute: (input: { readonly args: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          calls.push(input.args);
          return { stdout: replies(input.args), stderr: "", exitCode: 0, stdoutTruncated: false };
        }),
    };
    return { calls, host: makeGitHubPullRequestHost(github as never, "github.com") };
  };
  const target = { cwd: "/w", repository: "acme/stand", number: 7 };

  it("never needs a token in its arguments", () => {
    const { calls, host } = harness();
    Effect.runSync(host.runAction({ ...target, action: "close" }));
    expect(calls).toEqual([["pr", "close", "7", "--repo", "acme/stand"]]);
  });

  it("merges with the chosen method and deletes the branch when asked", () => {
    const { calls, host } = harness();
    Effect.runSync(
      host.runAction({ ...target, action: "merge", mergeMethod: "rebase", deleteBranch: true }),
    );
    expect(calls[0]).toEqual([
      "pr",
      "merge",
      "7",
      "--repo",
      "acme/stand",
      "--rebase",
      "--delete-branch",
    ]);
  });

  it("takes agent credits out of the squash message, pinned to the head it read", () => {
    const { calls, host } = harness((args) =>
      args[0] === "api"
        ? JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: "abc1234",
                  isMergeQueueEnabled: false,
                  viewerMergeBodyText:
                    "Details\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Ann <ann@acme.dev>",
                },
              },
            },
          })
        : "",
    );
    Effect.runSync(
      host.runAction({
        ...target,
        action: "merge",
        mergeMethod: "squash",
        removeAgentCredits: true,
      }),
    );
    const merge = calls.at(-1)!;
    expect(merge[merge.indexOf("--body") + 1]).toBe(
      "Details\n\nCo-authored-by: Ann <ann@acme.dev>",
    );
    expect(merge[merge.indexOf("--match-head-commit") + 1]).toBe("abc1234");
  });

  it("leaves a merge queue's message alone", () => {
    const { calls, host } = harness((args) =>
      args[0] === "api"
        ? JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: "abc1234",
                  isMergeQueueEnabled: true,
                  viewerMergeBodyText: "Co-Authored-By: Claude <noreply@anthropic.com>",
                },
              },
            },
          })
        : "",
    );
    Effect.runSync(host.runAction({ ...target, action: "merge", removeAgentCredits: true }));
    expect(calls.at(-1)).not.toContain("--body");
  });

  it("uses auto-merge's own flags", () => {
    const { calls, host } = harness();
    Effect.runSync(host.runAction({ ...target, action: "enable-auto-merge" }));
    Effect.runSync(host.runAction({ ...target, action: "disable-auto-merge" }));
    expect(calls[0]).toContain("--auto");
    expect(calls[1]).toContain("--disable-auto");
  });

  it("returns the revert's new pull request", () => {
    const { host } = harness((args) =>
      JSON.stringify({
        data: args.some((arg) => arg.includes("revertPullRequest("))
          ? { revertPullRequest: { revertPullRequest: { url: "https://x/pull/8" } } }
          : { repository: { pullRequest: { id: "PR_1" } } },
      }),
    );
    expect(Effect.runSync(host.runAction({ ...target, action: "revert" }))).toEqual({
      url: "https://x/pull/8",
    });
  });

  it("says a too large diff is too large, instead of failing", () => {
    const github = {
      execute: (input: { readonly args: ReadonlyArray<string> }) =>
        input.args[0] === "pr"
          ? Effect.fail({
              detail: "HTTP 406: Sorry, the diff exceeded the maximum number of files",
            })
          : Effect.succeed({
              stdout: JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      files: { pageInfo: { hasNextPage: false }, nodes: [] },
                    },
                  },
                },
              }),
              stderr: "",
              exitCode: 0,
              stdoutTruncated: false,
            }),
    };
    const host = makeGitHubPullRequestHost(github as never, "github.com");
    expect(Effect.runSync(host.diff!(target))).toEqual({ diff: "", files: [], truncated: true });
  });

  it("addresses an Enterprise server by host", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const github = {
      execute: (input: { readonly args: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          calls.push(input.args);
          return { stdout: "", stderr: "", exitCode: 0, stdoutTruncated: false };
        }),
    };
    const host = makeGitHubPullRequestHost(github as never, "ghe.acme.dev");
    Effect.runSync(host.runAction({ ...target, action: "reopen" }));
    expect(calls[0]).toContain("ghe.acme.dev/acme/stand");
  });
});

describe("what a client may pass", () => {
  it("takes repository names and refuses what could read as a flag or a path", () => {
    expect(isRepositoryName("acme/stand")).toBe(true);
    expect(isRepositoryName("group/sub/stand.web")).toBe(true);
    expect(isRepositoryName("--repo=evil/x")).toBe(false);
    expect(isRepositoryName("../../etc/passwd")).toBe(false);
    expect(isRepositoryName("noslash")).toBe(false);
  });

  it("takes commit ids only", () => {
    expect(isCommitSha("abc1234")).toBe(true);
    expect(isCommitSha("--output=/tmp/x")).toBe(false);
  });
});

it("claims every action GitHub has", () => {
  expect(GITHUB_PULL_REQUEST_CAPABILITIES.actions).toContain("revert");
});
