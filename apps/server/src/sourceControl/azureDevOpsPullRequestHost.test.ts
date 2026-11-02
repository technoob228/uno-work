/**
 * Answers are shaped as Azure DevOps documents them (Git REST: GitPullRequest,
 * GitPullRequestCommentThread, GitCommitRef; Policy: PolicyEvaluationRecord), as
 * `az … --output json` prints them. No live organization was used.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AzureDevOpsCliError, type AzureDevOpsCliShape } from "./AzureDevOpsCli.ts";
import {
  AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES,
  azureRefusal,
  buildListArgs,
  buildUpdateArgs,
  completionOutcome,
  makeAzureDevOpsPullRequestHost,
  parseAzureRepository,
  parseCommits,
  parseListRow,
  parsePolicies,
  parseThreads,
  reviewDecisionOf,
} from "./azureDevOpsPullRequestHost.ts";

const ORG = "https://dev.azure.com/acme";
const target = { organizationUrl: ORG, project: "Platform", name: "app" };

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  pullRequestId: 42,
  codeReviewId: 42,
  status: "active",
  isDraft: false,
  title: "Fix login",
  description: "Fixes it.",
  creationDate: "2026-10-30T09:00:00.000Z",
  closedDate: null,
  sourceRefName: "refs/heads/fix/login",
  targetRefName: "refs/heads/main",
  mergeStatus: "succeeded",
  lastMergeSourceCommit: { commitId: "abc123def456" },
  createdBy: {
    displayName: "Ana",
    uniqueName: "ana@acme.com",
    id: "a-1",
    imageUrl: "https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/a",
  },
  reviewers: [
    { displayName: "Bob", uniqueName: "bob@acme.com", id: "b-1", vote: 0, isRequired: true },
  ],
  labels: [
    { id: "l1", name: "bug", active: true },
    { id: "l2", name: "old", active: false },
  ],
  repository: {
    id: "r-1",
    name: "app",
    project: { id: "p-1", name: "Platform" },
    webUrl: "https://dev.azure.com/acme/Platform/_git/app",
  },
  url: "https://dev.azure.com/acme/p-1/_apis/git/repositories/r-1/pullRequests/42",
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}) =>
  parseListRow(pullRequest(overrides), {
    host: "dev.azure.com",
    repository: "acme/Platform/_git/app",
    target,
  });

interface Call {
  readonly args: ReadonlyArray<string>;
}

/** Answers by the first matching piece of the joined arguments. A function answers per call. */
function fakeAz(
  answers: ReadonlyArray<readonly [string, unknown]> = [],
  hostname = "dev.azure.com",
) {
  const calls: Call[] = [];
  const execute: AzureDevOpsCliShape["execute"] = (input) => {
    calls.push({ args: input.args });
    const joined = input.args.join(" ");
    const found = answers.find(([piece]) => joined.includes(piece))?.[1];
    const answer = typeof found === "function" ? (found as () => unknown)() : found;
    if (answer instanceof AzureDevOpsCliError) return Effect.fail(answer);
    return Effect.succeed({
      exitCode: 0 as never,
      stdout: answer === undefined ? "" : JSON.stringify(answer),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  };
  return {
    calls,
    host: makeAzureDevOpsPullRequestHost({ execute }, hostname, {
      completePollMs: 1,
      completePollAttempts: 2,
    }),
  };
}

/** As `AzureDevOpsCli` hands a failed `az` over: its reading, and stderr in the cause. */
const refusal = (stderr: string, detail = `VcsProcessExitError\n${stderr}`) =>
  new AzureDevOpsCliError({
    operation: "execute",
    detail,
    cause: { _tag: "VcsProcessExitError", detail: stderr },
  });

const failureText = (exit: { _tag: string }) =>
  exit._tag === "Failure" ? JSON.stringify(exit) : "";

const input = { cwd: "/repo", repository: "acme/Platform/_git/app", number: 42 };

describe("parseAzureRepository", () => {
  it.each([
    ["dev.azure.com", "acme/Platform/_git/app", ORG, "Platform", "app"],
    ["dev.azure.com", "acme/My%20Project/_git/my%20app", ORG, "My Project", "my app"],
    // A project named as its repository leaves it out of the address.
    ["dev.azure.com", "acme/_git/app", ORG, "app", "app"],
    ["ssh.dev.azure.com", "v3/acme/Platform/app", ORG, "Platform", "app"],
    [
      "acme.visualstudio.com",
      "Platform/_git/app",
      "https://acme.visualstudio.com",
      "Platform",
      "app",
    ],
    [
      "acme.visualstudio.com",
      "DefaultCollection/Platform/_git/app",
      "https://acme.visualstudio.com/DefaultCollection",
      "Platform",
      "app",
    ],
    [
      "vs-ssh.visualstudio.com",
      "v3/acme/Platform/app",
      "https://acme.visualstudio.com",
      "Platform",
      "app",
    ],
    [
      "tfs.acme.local",
      "tfs/Main/Platform/_git/app",
      "https://tfs.acme.local/tfs/Main",
      "Platform",
      "app",
    ],
  ])("reads %s %s", (host, repository, organizationUrl, project, name) => {
    expect(parseAzureRepository(host, repository)).toEqual({ organizationUrl, project, name });
  });

  it("refuses what isn't a repository path", () => {
    expect(parseAzureRepository("dev.azure.com", "acme/app")).toBeNull();
    expect(parseAzureRepository("dev.azure.com", "acme/Platform/_git/app/extra")).toBeNull();
    expect(parseAzureRepository("dev.azure.com", "_git/app")).toBeNull();
  });
});

describe("parseListRow", () => {
  it("reads a row", () => {
    expect(row()).toEqual({
      provider: "azure-devops",
      host: "dev.azure.com",
      repository: "acme/Platform/_git/app",
      number: 42,
      title: "Fix login",
      url: "https://dev.azure.com/acme/Platform/_git/app/pullrequest/42",
      author: { login: "ana@acme.com", name: "Ana", avatarUrl: null },
      headBranch: "fix/login",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 0,
      deletions: 0,
      createdAt: "2026-10-30T09:00:00.000Z",
      updatedAt: "2026-10-30T09:00:00.000Z",
      viewerReviewRequested: false,
      labels: [{ name: "bug", color: null }],
      reviewDecision: "review-required",
    });
  });

  it("maps the statuses and merge statuses", () => {
    expect(row({ status: "completed" })?.state).toBe("merged");
    expect(row({ status: "abandoned" })?.state).toBe("closed");
    expect(row({ mergeStatus: "conflicts" })?.mergeability).toBe("conflicting");
    expect(row({ mergeStatus: "queued" })?.mergeability).toBe("unknown");
    expect(row({ closedDate: "2026-10-31T00:00:00Z", status: "completed" })?.updatedAt).toBe(
      "2026-10-31T00:00:00Z",
    );
  });

  it("builds the address when the repository has no web link", () => {
    expect(row({ repository: undefined })?.url).toBe(
      "https://dev.azure.com/acme/Platform/_git/app/pullrequest/42",
    );
  });

  it("drops a row missing what the page needs", () => {
    expect(row({ sourceRefName: undefined })).toBeNull();
    expect(row({ pullRequestId: "42" })).toBeNull();
  });
});

describe("reviewDecisionOf", () => {
  const voting = (reviewers: ReadonlyArray<Record<string, unknown>>) =>
    reviewDecisionOf(pullRequest({ reviewers }));

  it("reads the votes", () => {
    expect(voting([])).toBeUndefined();
    expect(voting([{ vote: 10 }])).toBe("approved");
    expect(voting([{ vote: 5 }])).toBe("approved");
    expect(voting([{ vote: 10 }, { vote: -5 }])).toBe("changes-requested");
    expect(voting([{ vote: -10 }])).toBe("changes-requested");
    expect(voting([{ vote: 10 }, { vote: 0, isRequired: true }])).toBe("review-required");
    // A group's vote is its members'; it isn't counted again.
    expect(voting([{ vote: 10 }, { vote: 0, isContainer: true, isRequired: true }])).toBe(
      "approved",
    );
  });
});

describe("parsePolicies", () => {
  it("reads policy evaluations as checks", () => {
    const checks = parsePolicies(
      [
        {
          evaluationId: "e1",
          status: "approved",
          configuration: {
            isEnabled: true,
            isBlocking: true,
            type: { displayName: "Build" },
            settings: { displayName: "CI build" },
          },
          context: { buildId: 77 },
        },
        {
          evaluationId: "e2",
          status: "running",
          configuration: {
            isEnabled: true,
            isBlocking: true,
            type: { displayName: "Minimum number of reviewers" },
            settings: {},
          },
        },
        {
          evaluationId: "e3",
          status: "rejected",
          configuration: {
            isEnabled: true,
            isBlocking: false,
            type: { displayName: "Comment requirements" },
          },
        },
        { evaluationId: "e4", status: "notApplicable", configuration: { isEnabled: false } },
        { evaluationId: "e5", status: "broken", configuration: { type: {} } },
      ],
      target,
    );
    expect(checks).toEqual([
      {
        name: "CI build",
        status: "success",
        description: "Build",
        url: "https://dev.azure.com/acme/Platform/_build/results?buildId=77",
        required: true,
      },
      {
        name: "Minimum number of reviewers",
        status: "pending",
        description: null,
        url: null,
        required: true,
      },
      {
        name: "Comment requirements",
        status: "failure",
        description: null,
        url: null,
        required: false,
      },
    ]);
  });
});

describe("parseThreads", () => {
  it("keeps people's words and leaves Azure's own notes out", () => {
    const url = "https://dev.azure.com/acme/Platform/_git/app/pullrequest/42";
    const comments = parseThreads(
      {
        count: 3,
        value: [
          {
            id: 1,
            status: "active",
            threadContext: null,
            comments: [
              {
                id: 1,
                content: "Looks good",
                publishedDate: "2026-10-30T10:00:00Z",
                commentType: "text",
                author: { displayName: "Bob", uniqueName: "bob@acme.com" },
              },
              {
                id: 2,
                content: "Removed",
                publishedDate: "2026-10-30T10:01:00Z",
                isDeleted: true,
                commentType: "text",
              },
            ],
          },
          {
            id: 2,
            threadContext: { filePath: "/src/a.ts" },
            comments: [
              {
                id: 1,
                content: "Off by one",
                publishedDate: "2026-10-30T10:02:00Z",
                lastContentUpdatedDate: "2026-10-30T10:03:00Z",
                commentType: "text",
              },
            ],
          },
          {
            id: 3,
            comments: [
              {
                id: 1,
                content: "Ana voted 10",
                publishedDate: "2026-10-30T10:04:00Z",
                commentType: "system",
              },
            ],
          },
          { id: 4, isDeleted: true, comments: [{ id: 1, content: "x", publishedDate: "x" }] },
        ],
      },
      url,
    );
    expect(comments.map((comment) => [comment.id, comment.kind, comment.path])).toEqual([
      ["1:1", "issue-comment", null],
      ["2:1", "review-comment", "src/a.ts"],
    ]);
    expect(comments[0]?.url).toBe(`${url}?discussionId=1`);
    expect(comments[1]?.editedAt).toBe("2026-10-30T10:03:00Z");
  });
});

describe("parseCommits", () => {
  it("reads oldest first", () => {
    const commits = parseCommits({
      count: 2,
      value: [
        {
          commitId: "bbb",
          comment: "Second\n\nbody",
          author: { name: "Ana", email: "ana@acme.com", date: "2026-10-30T10:00:00Z" },
          committer: { name: "Ana", email: "ana@acme.com", date: "2026-10-30T10:00:00Z" },
        },
        {
          commitId: "aaa",
          comment: "First",
          author: { name: "Ana", email: "ana@acme.com", date: "2026-10-30T09:00:00Z" },
        },
      ],
    });
    expect(commits.map((commit) => [commit.oid, commit.messageHeadline])).toEqual([
      ["aaa", "First"],
      ["bbb", "Second"],
    ]);
    expect(commits[0]?.authors?.[0]).toEqual({
      login: "ana@acme.com",
      name: "Ana",
      avatarUrl: null,
    });
    expect(commits[0]?.url).toBeNull();
    const linked = parseCommits(
      {
        value: [
          { commitId: "aaa", comment: "A", author: { date: "2026-10-30T09:00:00Z" } },
          {
            commitId: "bbb",
            comment: "B",
            author: { date: "2026-10-30T10:00:00Z" },
            remoteUrl: "https://dev.azure.com/acme/Platform/_git/app/commit/bbb",
          },
        ],
      },
      "https://dev.azure.com/acme/Platform/_git/app",
    );
    expect(linked.map((commit) => commit.url)).toEqual([
      "https://dev.azure.com/acme/Platform/_git/app/commit/bbb",
      "https://dev.azure.com/acme/Platform/_git/app/commit/aaa",
    ]);
  });
});

describe("capabilities", () => {
  it("claims only what az can do", () => {
    expect(AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES).toEqual({
      actions: [
        "merge",
        "enable-auto-merge",
        "disable-auto-merge",
        "approve",
        "ready",
        "close",
        "reopen",
      ],
      mergeMethods: ["squash", "merge"],
      diff: false,
      comment: false,
      viewedFiles: false,
      mergeMessageRewrite: false,
      deleteBranch: true,
    });
    const host = fakeAz().host;
    expect(host.diff).toBeUndefined();
    expect(host.comment).toBeUndefined();
    expect(host.setFileViewed).toBeUndefined();
  });
});

describe("buildListArgs", () => {
  it("names the repository and maps the state", () => {
    expect(buildListArgs({ target, state: "merged", involvement: "all" })).toEqual([
      "repos",
      "pr",
      "list",
      "--org",
      ORG,
      "--project",
      "Platform",
      "--repository",
      "app",
      "--status",
      "completed",
      "--top",
      "51",
    ]);
    expect(buildListArgs({ target, state: "open", involvement: "all" })).toContain("active");
    expect(buildListArgs({ target, state: "closed", involvement: "all" })).toContain("abandoned");
  });

  it("narrows to the signed-in person as the extension spells it", () => {
    expect(buildListArgs({ target, state: "all", involvement: "authored" }).slice(-2)).toEqual([
      "--creator",
      "me",
    ]);
    expect(buildListArgs({ target, state: "all", involvement: "reviewing" }).slice(-2)).toEqual([
      "--reviewer",
      "me",
    ]);
  });
});

describe("buildUpdateArgs", () => {
  const base = ["repos", "pr", "update", "--id", "42", "--org", ORG];
  const of = (fields: Record<string, unknown>) =>
    buildUpdateArgs({ ...input, action: "merge", ...fields } as never, ORG);

  it("completes with the choices", () => {
    expect(of({ mergeMethod: "squash", deleteBranch: true })).toEqual([
      ...base,
      "--status",
      "completed",
      "--squash",
      "true",
      "--delete-source-branch",
      "true",
    ]);
    // No choice: the pull request's own completion options stand.
    expect(of({})).toEqual([...base, "--status", "completed"]);
    expect(of({ mergeMethod: "merge" })).toEqual([
      ...base,
      "--status",
      "completed",
      "--squash",
      "false",
    ]);
  });

  it("maps the other actions", () => {
    expect(of({ action: "enable-auto-merge", mergeMethod: "squash" })).toEqual([
      ...base,
      "--auto-complete",
      "true",
      "--squash",
      "true",
    ]);
    expect(of({ action: "disable-auto-merge" })).toEqual([...base, "--auto-complete", "false"]);
    expect(of({ action: "ready" })).toEqual([...base, "--draft", "false"]);
    expect(of({ action: "close" })).toEqual([...base, "--status", "abandoned"]);
    expect(of({ action: "reopen" })).toEqual([...base, "--status", "active"]);
    expect(of({ action: "revert" })).toBeNull();
  });
});

describe("azureRefusal", () => {
  it("takes az's ERROR line without the prefix", () => {
    expect(
      azureRefusal(
        "WARNING: something\nERROR: TF401027: You need the Git 'PullRequestContribute' permission to perform this action.",
      ),
    ).toBe("TF401027: You need the Git 'PullRequestContribute' permission to perform this action.");
    expect(azureRefusal("")).toBeNull();
  });
});

describe("completionOutcome", () => {
  it("tells done, held and still going apart", () => {
    expect(completionOutcome(pullRequest({ status: "completed" }))).toBe("done");
    expect(completionOutcome(pullRequest({ mergeStatus: "conflicts" }))).toMatch(/conflicts/u);
    expect(completionOutcome(pullRequest({ mergeStatus: "rejectedByPolicy" }))).toMatch(/policy/u);
    expect(
      completionOutcome(
        pullRequest({ mergeStatus: "failure", mergeFailureMessage: "The merge had a problem." }),
      ),
    ).toBe("The merge had a problem.");
    expect(completionOutcome(pullRequest({ mergeStatus: "queued" }))).toBe("pending");
  });
});

describe("the host", () => {
  it("lists per repository, looking for the words itself", async () => {
    const fake = fakeAz([
      [
        "repos pr list",
        [pullRequest(), pullRequest({ pullRequestId: 43, title: "Bump deps", description: "" })],
      ],
    ]);
    const list = await Effect.runPromise(
      fake.host.list({
        cwd: "/repo",
        repositories: ["acme/Platform/_git/app", "not/an/azure/path"],
        state: "open",
        involvement: "reviewing",
        query: "LOGIN",
      }),
    );
    expect(list.rows.map((entry) => entry.number)).toEqual([42]);
    expect(list.rows[0]?.viewerReviewRequested).toBe(true);
    expect(list).toMatchObject({ viewer: null, truncated: false });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args.slice(-5, -3)).toEqual(["--reviewer", "me"]);
  });

  it("says when a repository has more than a page", async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      pullRequest({ pullRequestId: index + 1 }),
    );
    const fake = fakeAz([["repos pr list", many]]);
    const list = await Effect.runPromise(
      fake.host.list({
        cwd: "/repo",
        repositories: ["acme/Platform/_git/app"],
        state: "all",
        involvement: "all",
      }),
    );
    expect(list.rows).toHaveLength(50);
    expect(list.truncated).toBe(true);
  });

  it("reads a detail with policies, threads and commits", async () => {
    const fake = fakeAz([
      ["repos pr show", pullRequest({ autoCompleteSetBy: { id: "a-1", displayName: "Ana" } })],
      [
        "repos pr policy list",
        [
          {
            status: "rejected",
            configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Build" } },
          },
        ],
      ],
      [
        "pullRequestThreads",
        {
          value: [
            {
              id: 9,
              comments: [
                {
                  id: 1,
                  content: "Hi",
                  publishedDate: "2026-10-30T10:00:00Z",
                  commentType: "text",
                },
              ],
            },
          ],
        },
      ],
      [
        "pullRequestCommits",
        {
          value: [{ commitId: "aaa", comment: "First", author: { date: "2026-10-30T09:00:00Z" } }],
        },
      ],
    ]);
    const detail = await Effect.runPromise(fake.host.detail(input));
    expect(detail).toMatchObject({
      provider: "azure-devops",
      number: 42,
      headSha: "abc123def456",
      autoMergeEnabled: true,
      checks: [{ name: "Build", status: "failure", required: true }],
      comments: [{ body: "Hi" }],
      commits: [{ oid: "aaa" }],
      mergeMethods: ["squash", "merge"],
    });
    const invoke = fake.calls.find((call) => call.args.includes("pullRequestThreads"))?.args;
    expect(invoke).toEqual([
      "devops",
      "invoke",
      "--org",
      ORG,
      "--area",
      "git",
      "--resource",
      "pullRequestThreads",
      "--route-parameters",
      "project=Platform",
      "repositoryId=app",
      "pullRequestId=42",
      "--http-method",
      "GET",
      "--only-show-errors",
      "--output",
      "json",
    ]);
  });

  it("keeps the detail when threads, commits and policies can't be read", async () => {
    const fake = fakeAz([
      [
        "repos pr show",
        pullRequest({ autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } }),
      ],
      ["repos pr policy list", refusal("ERROR: TF401027: You need the permission.")],
      ["devops invoke", refusal("ERROR: The resource cannot be found.")],
    ]);
    const detail = await Effect.runPromise(fake.host.detail(input));
    expect(detail).toMatchObject({
      checks: [],
      comments: [],
      commits: [],
      autoMergeEnabled: false,
    });
  });

  it("approves with a vote", async () => {
    const fake = fakeAz();
    await Effect.runPromise(fake.host.runAction({ ...input, action: "approve" }));
    expect(fake.calls[0]?.args.slice(0, 9)).toEqual([
      "repos",
      "pr",
      "set-vote",
      "--id",
      "42",
      "--vote",
      "approve",
      "--org",
      ORG,
    ]);
  });

  it("merges once Azure says it completed", async () => {
    let shows = 0;
    const fake = fakeAz([
      ["repos pr update", pullRequest({ mergeStatus: "queued" })],
      [
        "repos pr show",
        () => {
          shows += 1;
          return pullRequest({ status: shows > 1 ? "completed" : "active", mergeStatus: "queued" });
        },
      ],
    ]);
    await Effect.runPromise(
      fake.host.runAction({ ...input, action: "merge", mergeMethod: "squash" }),
    );
    expect(shows).toBe(2);
  });

  it("says what holds a completion", async () => {
    const conflicts = fakeAz([["repos pr update", pullRequest({ mergeStatus: "conflicts" })]]);
    const exit = await Effect.runPromiseExit(
      conflicts.host.runAction({ ...input, action: "merge" }),
    );
    expect(failureText(exit)).toContain("conflicts");

    const waiting = fakeAz([
      ["repos pr update", pullRequest({ mergeStatus: "succeeded" })],
      ["repos pr show", pullRequest({ mergeStatus: "succeeded" })],
      [
        "repos pr policy list",
        [
          {
            status: "running",
            configuration: {
              isEnabled: true,
              isBlocking: true,
              type: { displayName: "Build" },
              settings: { displayName: "CI build" },
            },
          },
        ],
      ],
    ]);
    const held = await Effect.runPromiseExit(waiting.host.runAction({ ...input, action: "merge" }));
    expect(failureText(held)).toContain('waiting on \\"CI build\\"');
  });

  it("says still completing when nothing explains the wait", async () => {
    const fake = fakeAz([
      ["repos pr update", pullRequest({ mergeStatus: "queued" })],
      ["repos pr show", pullRequest({ mergeStatus: "queued" })],
      ["repos pr policy list", []],
    ]);
    const exit = await Effect.runPromiseExit(fake.host.runAction({ ...input, action: "merge" }));
    expect(failureText(exit)).toContain("still completing");
  });

  it("passes az's own words on, not its error tag", async () => {
    const fake = fakeAz([
      [
        "repos pr update",
        refusal(
          "ERROR: TF401027: You need the Git 'PullRequestContribute' permission to perform this action.",
        ),
      ],
    ]);
    const exit = await Effect.runPromiseExit(fake.host.runAction({ ...input, action: "close" }));
    expect(failureText(exit)).toContain(
      `"detail":"TF401027: You need the Git 'PullRequestContribute' permission to perform this action."`,
    );
  });

  it("keeps the sign-in reading so the page points to Settings", async () => {
    const fake = fakeAz([
      [
        "repos pr show",
        refusal(
          "ERROR: Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.",
          "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.",
        ),
      ],
    ]);
    const exit = await Effect.runPromiseExit(fake.host.detail(input));
    expect(failureText(exit)).toContain("not authenticated");
  });

  it("refuses a revert rather than inventing one", async () => {
    const fake = fakeAz();
    const exit = await Effect.runPromiseExit(fake.host.runAction({ ...input, action: "revert" }));
    expect(exit._tag).toBe("Failure");
    expect(fake.calls).toEqual([]);
  });
});
