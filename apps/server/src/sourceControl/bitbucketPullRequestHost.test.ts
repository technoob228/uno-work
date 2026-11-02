import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { BitbucketApiError, type BitbucketApiShape } from "./BitbucketApi.ts";
import {
  BITBUCKET_PULL_REQUEST_CAPABILITIES,
  buildListPath,
  buildMergeBody,
  makeBitbucketPullRequestHost,
  parseComments,
  parseCommits,
  parseDetail,
  parseDiffstat,
  parseListRow,
  parseMergeMethods,
  parseReviews,
  parseStatuses,
  repositoryPath,
} from "./bitbucketPullRequestHost.ts";

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  title: "Fix login",
  description: "Fixes it.",
  state: "OPEN",
  draft: false,
  created_on: "2026-10-30T09:00:00.123456+00:00",
  updated_on: "2026-10-30T10:00:00.000000+00:00",
  links: { html: { href: "https://bitbucket.org/acme/app/pull-requests/7" } },
  author: {
    nickname: "ana",
    display_name: "Ana",
    uuid: "{a}",
    links: { avatar: { href: "https://avatar/ana" } },
  },
  source: { branch: { name: "fix/login" }, commit: { hash: "abc123def456" } },
  destination: { branch: { name: "main" } },
  reviewers: [{ nickname: "bob", display_name: "Bob", uuid: "{b}" }],
  participants: [],
  ...overrides,
});

const viewer = { login: "bob", uuid: "{b}" };
const row = (overrides: Record<string, unknown> = {}) =>
  parseListRow(pullRequest(overrides), "bitbucket.org", "acme/app", viewer);

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

function fakeBitbucket(answers: ReadonlyArray<readonly [string, unknown]> = []) {
  const calls: Call[] = [];
  const request: BitbucketApiShape["request"] = (input) => {
    calls.push({
      method: input.method,
      url: input.url,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const answer = answers.find(([piece]) => input.url.includes(piece))?.[1];
    if (answer instanceof BitbucketApiError) return Effect.fail(answer);
    return Effect.succeed({
      body: typeof answer === "string" ? answer : JSON.stringify(answer ?? {}),
      truncated: false,
    });
  };
  return { calls, host: makeBitbucketPullRequestHost({ request }, "bitbucket.org") };
}

const target = { cwd: "/repo", repository: "acme/app", number: 7 };

describe("buildListPath", () => {
  it("asks for the states and the fields rows need", () => {
    const path = buildListPath({
      repository: "acme/app",
      state: "closed",
      involvement: "all",
      viewer,
    });
    expect(path).toBe(
      "/repositories/acme/app/pullrequests?state=DECLINED&state=SUPERSEDED&pagelen=50&sort=-updated_on&fields=%2Bvalues.reviewers%2C%2Bvalues.participants",
    );
  });

  it("narrows by the viewer's uuid and escapes a search", () => {
    const shared = { repository: "acme/app", state: "open", viewer } as const;
    expect(decodeURIComponent(buildListPath({ ...shared, involvement: "authored" })!)).toContain(
      'q=author.uuid = "{b}"',
    );
    expect(decodeURIComponent(buildListPath({ ...shared, involvement: "reviewing" })!)).toContain(
      'q=reviewers.uuid = "{b}"',
    );
    const searched = decodeURIComponent(
      buildListPath({ ...shared, involvement: "all", query: 'a" OR state = "MERGED' })!,
    );
    expect(searched).toContain('title ~ "a\\" OR state = \\"MERGED"');
  });

  it("refuses what isn't workspace/name", () => {
    expect(repositoryPath("a/b/c")).toBeNull();
    expect(repositoryPath("a")).toBeNull();
    expect(repositoryPath("acme/my app")).toBe("/repositories/acme/my%20app");
  });
});

describe("parseListRow", () => {
  it("reads a row", () => {
    expect(row()).toMatchObject({
      provider: "bitbucket",
      repository: "acme/app",
      number: 7,
      url: "https://bitbucket.org/acme/app/pull-requests/7",
      headBranch: "fix/login",
      baseBranch: "main",
      state: "open",
      mergeability: "unknown",
      createdAt: "2026-10-30T09:00:00.123Z",
      viewerReviewRequested: true,
      author: { login: "ana", name: "Ana", avatarUrl: "https://avatar/ana" },
      reviewDecision: "review-required",
      labels: [],
    });
  });

  it("maps the states", () => {
    expect(row({ state: "OPEN" })?.state).toBe("open");
    expect(row({ state: "MERGED" })?.state).toBe("merged");
    expect(row({ state: "DECLINED" })?.state).toBe("closed");
    expect(row({ state: "SUPERSEDED" })?.state).toBe("closed");
  });

  it("reads votes", () => {
    expect(row({ participants: [{ state: "approved", approved: true }] })?.reviewDecision).toBe(
      "approved",
    );
    expect(
      row({ participants: [{ state: "approved" }, { state: "changes_requested" }] })
        ?.reviewDecision,
    ).toBe("changes-requested");
    expect(row({ reviewers: [] })?.reviewDecision).toBeUndefined();
  });

  it("drops a row missing what the page needs", () => {
    expect(row({ links: {} })).toBeNull();
    expect(row({ created_on: "not a date" })).toBeNull();
  });
});

describe("parsers", () => {
  it("keeps the latest status per key", () => {
    expect(
      parseStatuses([
        { key: "ci", name: "CI", state: "FAILED" },
        { key: "ci", name: "CI", state: "SUCCESSFUL", url: "https://ci/2" },
        { key: "lint", state: "INPROGRESS" },
        { key: "old", name: "Old", state: "STOPPED" },
      ]),
    ).toEqual([
      { name: "CI", status: "success", description: null, url: "https://ci/2" },
      { name: "lint", status: "pending", description: null, url: null },
      { name: "Old", status: "cancelled", description: null, url: null },
    ]);
  });

  it("leaves deleted, pending and empty comments out", () => {
    const comments = parseComments([
      { id: 1, content: { raw: "Hi" }, created_on: "2026-10-30T09:00:00Z", user: { nickname: "bob" } },
      { id: 2, content: { raw: "x" }, created_on: "2026-10-30T09:00:00Z", deleted: true },
      { id: 3, content: { raw: "x" }, created_on: "2026-10-30T09:00:00Z", pending: true },
      { id: 4, content: { raw: " " }, created_on: "2026-10-30T09:00:00Z" },
      {
        id: 5,
        content: { raw: "Off by one" },
        created_on: "2026-10-30T09:01:00Z",
        inline: { path: "src/a.ts", to: 3 },
        links: { html: { href: "https://bb/c/5" } },
      },
    ]);
    expect(comments.map((comment) => [comment.id, comment.kind, comment.path])).toEqual([
      ["1", "issue-comment", null],
      ["5", "review-comment", "src/a.ts"],
    ]);
    expect(comments[1]?.url).toBe("https://bb/c/5");
  });

  it("puts votes in the timeline", () => {
    expect(
      parseReviews(
        pullRequest({
          participants: [
            { user: { nickname: "bob" }, state: "changes_requested", participated_on: "2026-10-30T11:00:00Z" },
            { user: { nickname: "eve" }, state: null, participated_on: "2026-10-30T11:00:00Z" },
          ],
        }),
      ),
    ).toEqual([
      {
        id: "7:bob",
        kind: "review",
        author: { login: "bob", name: null, avatarUrl: null },
        body: "",
        createdAt: "2026-10-30T11:00:00.000Z",
        url: null,
        path: null,
        reviewState: "changes requested",
      },
    ]);
  });

  it("reads commits oldest first", () => {
    const commits = parseCommits([
      { hash: "bbb", message: "Second\n\nbody", date: "2026-10-30T10:00:00+00:00", author: { raw: "Ana <a@x>" } },
      { hash: "aaa", message: "First", date: "2026-10-30T09:00:00+00:00", author: { user: { nickname: "ana" } } },
    ]);
    expect(commits.map((commit) => [commit.oid, commit.messageHeadline])).toEqual([
      ["aaa", "First"],
      ["bbb", "Second"],
    ]);
    expect(commits[1]?.authors?.[0]?.login).toBe("Ana <a@x>");
  });

  it("reads files from the diffstat, all unviewed", () => {
    expect(
      parseDiffstat([
        { new: { path: "src/a.ts" }, old: { path: "src/a.ts" }, lines_added: 2, lines_removed: 1 },
        { new: null, old: { path: "gone.ts" }, lines_added: 0, lines_removed: 4 },
      ]),
    ).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1, viewed: "unviewed" },
      { path: "gone.ts", additions: 0, deletions: 4, viewed: "unviewed" },
    ]);
  });

  it("narrows merge methods to what the target branch allows", () => {
    expect(
      parseMergeMethods(
        pullRequest({
          destination: {
            branch: { name: "main", merge_strategies: ["squash", "fast_forward"] },
          },
        }),
      ),
    ).toEqual(["squash"]);
    expect(parseMergeMethods(pullRequest())).toEqual(["merge", "squash", "rebase"]);
  });

  it("reads one pull request", () => {
    const detail = parseDetail(pullRequest({ state: "MERGED", closed_on: "2026-10-31T00:00:00+00:00" }), {
      host: "bitbucket.org",
      repository: "acme/app",
      viewer,
      files: [
        { path: "a" as never, additions: 3 as never, deletions: 1 as never, viewed: "unviewed" },
        { path: "b" as never, additions: 2 as never, deletions: 0 as never, viewed: "unviewed" },
      ],
      conflicts: false,
      checks: [],
      comments: [],
      commits: [],
    });
    expect(detail).toMatchObject({
      state: "merged",
      mergedAt: "2026-10-31T00:00:00.000Z",
      closedAt: null,
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      headSha: "abc123def456",
      mergeability: "mergeable",
      viewer: "bob",
    });
    expect(detail?.autoMergeEnabled).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("claims only merge, approve and decline", () => {
    expect(BITBUCKET_PULL_REQUEST_CAPABILITIES).toEqual({
      actions: ["merge", "approve", "close"],
      mergeMethods: ["merge", "squash", "rebase"],
      diff: true,
      comment: true,
      viewedFiles: false,
      mergeMessageRewrite: false,
      deleteBranch: true,
    });
    expect(fakeBitbucket().host.setFileViewed).toBeUndefined();
  });
});

describe("runAction", () => {
  const run = async (input: Record<string, unknown>) => {
    const fake = fakeBitbucket();
    await Effect.runPromise(fake.host.runAction({ ...target, action: "merge", ...input } as never));
    return fake.calls;
  };
  const path = "/repositories/acme/app/pullrequests/7";

  it("maps a merge to a strategy and the branch choice", async () => {
    expect(buildMergeBody({ ...target, action: "merge", mergeMethod: "rebase", deleteBranch: false })).toEqual({
      merge_strategy: "rebase_fast_forward",
      close_source_branch: false,
    });
    expect(await run({ mergeMethod: "squash", deleteBranch: true })).toEqual([
      {
        method: "POST",
        url: `${path}/merge`,
        body: { merge_strategy: "squash", close_source_branch: true },
      },
    ]);
  });

  it("approves and declines", async () => {
    expect(await run({ action: "approve" })).toEqual([{ method: "POST", url: `${path}/approve` }]);
    expect(await run({ action: "close" })).toEqual([{ method: "POST", url: `${path}/decline` }]);
  });

  it.each(["reopen", "ready", "enable-auto-merge", "revert"])(
    "refuses %s rather than inventing it",
    async (action) => {
      const fake = fakeBitbucket();
      const exit = await Effect.runPromiseExit(
        fake.host.runAction({ ...target, action } as never),
      );
      expect(exit._tag).toBe("Failure");
      expect(fake.calls).toEqual([]);
    },
  );
});

describe("the host", () => {
  it("lists with the viewer read once", async () => {
    const fake = fakeBitbucket([
      ["/user", { nickname: "bob", uuid: "{b}" }],
      ["/pullrequests?", { values: [pullRequest()], next: "https://api.bitbucket.org/2.0/x?page=2" }],
    ]);
    const input = {
      cwd: "/repo",
      repositories: ["acme/app"],
      state: "open",
      involvement: "reviewing",
    } as const;
    const list = await Effect.runPromise(fake.host.list(input));
    await Effect.runPromise(fake.host.list(input));
    expect(list).toMatchObject({ viewer: "bob", truncated: true });
    expect(list.rows).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url === "/user")).toHaveLength(1);
  });

  it("says not signed in on a 401, so the page sends the person to Settings", async () => {
    const fake = fakeBitbucket([
      ["/user", new BitbucketApiError({ operation: "request", status: 401, detail: "HTTP 401" })],
    ]);
    const exit = await Effect.runPromiseExit(
      fake.host.list({ cwd: "/repo", repositories: ["acme/app"], state: "open", involvement: "all" }),
    );
    expect(JSON.stringify(exit)).toContain("not authenticated");
  });

  it("reads a detail and keeps it when the build statuses are refused", async () => {
    const fake = fakeBitbucket([
      ["/user", { nickname: "bob", uuid: "{b}" }],
      ["/diffstat", { values: [{ new: { path: "a" }, lines_added: 1, lines_removed: 0 }] }],
      ["/conflicts", { values: [{ path: "a" }] }],
      ["/statuses", new BitbucketApiError({ operation: "request", status: 403, detail: "no" })],
      ["/comments", { values: [] }],
      ["/commits", { values: [] }],
      ["/pullrequests/7?", pullRequest()],
    ]);
    const detail = await Effect.runPromise(fake.host.detail(target));
    expect(detail).toMatchObject({ mergeability: "conflicting", additions: 1, checks: [] });
  });

  it("empties a cut diff but keeps the files", async () => {
    const calls: string[] = [];
    const host = makeBitbucketPullRequestHost(
      {
        request: (input) => {
          calls.push(input.url);
          return Effect.succeed(
            input.url.includes("diffstat")
              ? { body: JSON.stringify({ values: [{ new: { path: "a" } }] }), truncated: false }
              : { body: "diff --git a/a b/a\n", truncated: true },
          );
        },
      },
      "bitbucket.org",
    );
    const diff = await Effect.runPromise(host.diff!({ ...target, commit: "abc1234" }));
    expect(diff).toEqual({
      diff: "",
      truncated: true,
      files: [{ path: "a", additions: 0, deletions: 0, viewed: "unviewed" }],
    });
    expect(calls.toSorted()).toEqual([
      "/repositories/acme/app/diff/abc1234",
      "/repositories/acme/app/diffstat/abc1234?pagelen=50",
    ]);
  });

  it("comments with the body in JSON, never in the address", async () => {
    const fake = fakeBitbucket();
    await Effect.runPromise(fake.host.comment!({ ...target, body: "?q=x&state=MERGED" }));
    expect(fake.calls).toEqual([
      { method: "POST", url: "/repositories/acme/app/pullrequests/7/comments", body: { content: { raw: "?q=x&state=MERGED" } } },
    ]);
  });
});
