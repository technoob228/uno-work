import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { GitLabCliError, type GitLabCliShape } from "./GitLabCli.ts";
import {
  buildListPath,
  buildMergeBody,
  GITLAB_PULL_REQUEST_CAPABILITIES,
  makeGitLabPullRequestHost,
  parseCommits,
  parseDetail,
  parseDiffPage,
  parseJobs,
  parseListRow,
  parseMergeMethods,
  parseNotes,
  parseRowFacts,
} from "./gitLabPullRequestHost.ts";

const mergeRequest = (overrides: Record<string, unknown> = {}) => ({
  iid: 12,
  title: "Fix login",
  web_url: "https://gitlab.com/acme/platform/app/-/merge_requests/12",
  description: "Fixes it.",
  source_branch: "fix/login",
  target_branch: "main",
  state: "opened",
  draft: false,
  has_conflicts: false,
  detailed_merge_status: "mergeable",
  created_at: "2026-10-30T09:00:00.000Z",
  updated_at: "2026-10-30T10:00:00.000Z",
  merged_at: null,
  closed_at: null,
  author: { username: "ana", name: "Ana", avatar_url: "https://gitlab.com/ana.png" },
  reviewers: [{ username: "Bob", name: "Bob", avatar_url: null }],
  labels: [{ name: "bug", color: "#ff0000" }, "plain"],
  ...overrides,
});

const row = (overrides: Record<string, unknown> = {}, viewer: string | null = "bob") =>
  parseListRow(mergeRequest(overrides), "gitlab.com", "acme/platform/app", viewer);

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly host?: string;
}

/** Answers by the first matching path piece, and remembers what it was asked. */
function fakeGitLab(answers: ReadonlyArray<readonly [string, unknown]> = []) {
  const calls: Call[] = [];
  const execute: GitLabCliShape["execute"] = (input) => {
    calls.push({
      args: input.args,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
    });
    const joined = input.args.join(" ");
    const answer = answers.find(([piece]) => joined.includes(piece));
    if (answer?.[1] instanceof GitLabCliError) return Effect.fail(answer[1]);
    return Effect.succeed({
      exitCode: 0 as never,
      stdout: JSON.stringify(answer?.[1] ?? {}),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  };
  return { calls, host: makeGitLabPullRequestHost({ execute }, "gitlab.example.com") };
}

const target = { cwd: "/repo", repository: "acme/platform/app", number: 12 };
const encoded = "projects/acme%2Fplatform%2Fapp";

describe("buildListPath", () => {
  it("encodes a nested project and maps the state", () => {
    const path = buildListPath({
      repository: "acme/platform/app",
      state: "open",
      involvement: "all",
      viewer: "bob",
    });
    expect(path.startsWith(`${encoded}/merge_requests?state=opened&`)).toBe(true);
    expect(path).toContain("per_page=51");
    expect(path).not.toContain("author_username");
    expect(path).not.toContain("reviewer_username");
  });

  it.each([
    ["all", "all"],
    ["closed", "closed"],
    ["merged", "merged"],
  ] as const)("asks GitLab for %s as %s", (state, param) => {
    const path = buildListPath({
      repository: "a/b",
      state,
      involvement: "all",
      viewer: "bob",
    });
    expect(path).toContain(`state=${param}&`);
  });

  it("narrows by the viewer and keeps a search in one piece", () => {
    const shared = { repository: "a/b", state: "all", viewer: "bob" } as const;
    expect(buildListPath({ ...shared, involvement: "authored" })).toContain("author_username=bob");
    expect(buildListPath({ ...shared, involvement: "reviewing" })).toContain(
      "reviewer_username=bob",
    );
    expect(buildListPath({ ...shared, involvement: "all", query: "a&state=closed" })).toContain(
      "search=a%26state%3Dclosed",
    );
  });
});

describe("parseListRow", () => {
  it("reads a row", () => {
    expect(row()).toMatchObject({
      provider: "gitlab",
      host: "gitlab.com",
      repository: "acme/platform/app",
      number: 12,
      url: "https://gitlab.com/acme/platform/app/-/merge_requests/12",
      headBranch: "fix/login",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      viewerReviewRequested: true,
      author: { login: "ana", name: "Ana" },
      labels: [
        { name: "bug", color: "#ff0000" },
        { name: "plain", color: null },
      ],
    });
  });

  it("drops a row missing what the page needs", () => {
    expect(row({ web_url: null })).toBeNull();
    expect(row({ iid: "12" })).toBeNull();
  });

  it("maps the states", () => {
    expect(row({ state: "opened" })?.state).toBe("open");
    expect(row({ state: "locked" })?.state).toBe("open");
    expect(row({ state: "closed" })?.state).toBe("closed");
    expect(row({ state: "merged" })?.state).toBe("merged");
    expect(row({ state: "closed", merged_at: "2026-10-30T11:00:00.000Z" })?.state).toBe("merged");
  });

  it("reads a draft under either name", () => {
    expect(row({ draft: true })?.isDraft).toBe(true);
    expect(row({ draft: undefined, work_in_progress: true })?.isDraft).toBe(true);
  });

  it("separates conflicts from other gates and from not knowing yet", () => {
    expect(row({ has_conflicts: true })?.mergeability).toBe("conflicting");
    expect(row({ detailed_merge_status: "conflict" })?.mergeability).toBe("conflicting");
    expect(row({ detailed_merge_status: "checking" })?.mergeability).toBe("unknown");
    expect(row({ detailed_merge_status: "not_approved" })?.mergeability).toBe("mergeable");
    expect(row({ detailed_merge_status: "ci_must_pass" })?.mergeability).toBe("mergeable");
  });

  it("knows the viewer only among the reviewers", () => {
    expect(row({}, "ana")?.viewerReviewRequested).toBe(false);
    expect(row({ reviewers: [] })?.viewerReviewRequested).toBe(false);
    expect(row({}, null)?.viewerReviewRequested).toBe(false);
  });

  it("takes the review state GitLab states outright", () => {
    expect(row({ detailed_merge_status: "not_approved" })?.reviewDecision).toBe("review-required");
    expect(row({ detailed_merge_status: "requested_changes" })?.reviewDecision).toBe(
      "changes-requested",
    );
    expect(row()?.reviewDecision).toBeUndefined();
  });
});

describe("parseRowFacts", () => {
  const answer = (metadata: unknown, nodes: ReadonlyArray<unknown>) => ({
    data: { metadata, project: { mergeRequests: { nodes } } },
  });

  it("reads line counts and the head pipeline", () => {
    const facts = parseRowFacts(
      answer({ enterprise: false }, [
        {
          iid: "12",
          approved: true,
          approvedBy: { nodes: [{ username: "bob" }] },
          diffStatsSummary: { additions: 7, deletions: 2 },
          headPipeline: { status: "SUCCESS" },
        },
        {
          iid: "13",
          approved: true,
          approvedBy: { nodes: [] },
          headPipeline: { status: "FAILED" },
        },
        { iid: "14", headPipeline: { status: "RUNNING" } },
        { iid: "15", headPipeline: null },
      ]),
    );
    expect(facts.get(12)).toEqual({
      additions: 7,
      deletions: 2,
      checksState: "passing",
      reviewDecision: "approved",
    });
    expect(facts.get(13)).toEqual({ additions: 0, deletions: 0, checksState: "failing" });
    expect(facts.get(14)?.checksState).toBe("pending");
    expect(facts.get(15)?.checksState).toBeUndefined();
  });

  it("needs review on Enterprise, where approval rules count", () => {
    const unapproved = { iid: "12", approved: false, approvedBy: { nodes: [] } };
    expect(parseRowFacts(answer({ enterprise: true }, [unapproved])).get(12)?.reviewDecision).toBe(
      "review-required",
    );
    expect(
      parseRowFacts(answer({ enterprise: false }, [unapproved])).get(12)?.reviewDecision,
    ).toBeUndefined();
  });

  it("survives an answer with no data", () => {
    expect(parseRowFacts({ errors: [] }).size).toBe(0);
    expect(parseRowFacts(null).size).toBe(0);
  });
});

describe("parseJobs", () => {
  it("reads jobs as checks", () => {
    const checks = parseJobs([
      {
        name: "unit",
        stage: "test",
        status: "failed",
        failure_reason: "script_failure",
        web_url: "https://gitlab.com/j/1",
        allow_failure: false,
      },
      { name: "lint", stage: "test", status: "failed", allow_failure: true },
      { name: "build", stage: "build", status: "success", allow_failure: false },
      { name: "deploy", stage: "deploy", status: "manual", allow_failure: false },
      { name: "preview", stage: "deploy", status: "manual", allow_failure: true },
      { name: "e2e", stage: "test", status: "running", allow_failure: false },
      { name: "old", stage: "test", status: "canceled", allow_failure: false },
      { name: "nope", stage: "test", status: "skipped", allow_failure: false },
      { stage: "nameless" },
    ]);
    expect(checks[0]).toEqual({
      name: "test / unit",
      status: "failure",
      description: "script_failure",
      url: "https://gitlab.com/j/1",
      required: true,
    });
    expect(checks.map((check) => check.status)).toEqual([
      "failure",
      "neutral",
      "success",
      "action-required",
      "neutral",
      "pending",
      "cancelled",
      "skipped",
    ]);
  });
});

describe("parseNotes", () => {
  it("drops system notes and links the rest", () => {
    const notes = parseNotes(
      [
        {
          id: 1,
          body: "approved this merge request",
          system: true,
          created_at: "2026-10-30T09:00:00Z",
        },
        { id: 2, body: "   ", created_at: "2026-10-30T09:00:00Z" },
        {
          id: 3,
          body: "Looks fine",
          author: { username: "bob" },
          created_at: "2026-10-30T09:05:00Z",
        },
        {
          id: 4,
          body: "Off by one",
          type: "DiffNote",
          position: { new_path: "src/a.ts" },
          created_at: "2026-10-30T09:06:00Z",
        },
      ],
      "https://gitlab.com/a/b/-/merge_requests/1",
    );
    expect(notes.map((note) => note.id)).toEqual(["3", "4"]);
    expect(notes[0]).toMatchObject({
      kind: "issue-comment",
      url: "https://gitlab.com/a/b/-/merge_requests/1#note_3",
      path: null,
    });
    expect(notes[1]).toMatchObject({ kind: "review-comment", path: "src/a.ts" });
  });
});

describe("parseCommits", () => {
  it("reads oldest first", () => {
    const commits = parseCommits([
      {
        id: "bbb",
        title: "Second",
        committed_date: "2026-10-30T10:00:00Z",
        author_name: "Ana",
        web_url: "https://gitlab.com/c/bbb",
      },
      { id: "aaa", title: "First", created_at: "2026-10-30T09:00:00Z" },
    ]);
    expect(commits.map((commit) => commit.oid)).toEqual(["aaa", "bbb"]);
    expect(commits[1]).toMatchObject({
      messageHeadline: "Second",
      url: "https://gitlab.com/c/bbb",
      authors: [{ login: "Ana", name: "Ana", avatarUrl: null }],
    });
    expect(commits[0]?.authors).toEqual([]);
  });
});

describe("parseMergeMethods", () => {
  it.each([
    [{ merge_method: "merge", squash_option: "default_off" }, ["merge", "squash"]],
    [{ merge_method: "merge", squash_option: "never" }, ["merge"]],
    [{ merge_method: "rebase_merge", squash_option: "default_on" }, ["squash", "rebase"]],
    [{ merge_method: "ff", squash_option: "never" }, ["rebase"]],
    [{ merge_method: "merge", squash_option: "always" }, ["squash"]],
  ])("narrows to what %j allows", (project, methods) => {
    expect(parseMergeMethods(project)).toEqual(methods);
  });

  it("offers everything the host can when the settings are hidden", () => {
    expect(parseMergeMethods({})).toEqual(GITLAB_PULL_REQUEST_CAPABILITIES.mergeMethods);
    expect(parseMergeMethods(null)).toEqual(GITLAB_PULL_REQUEST_CAPABILITIES.mergeMethods);
  });
});

describe("parseDetail", () => {
  const context = {
    host: "gitlab.com",
    repository: "acme/platform/app",
    viewer: "bob",
    comments: [],
    commits: [],
    checks: [],
    mergeMethods: ["merge"],
  } as const;

  it("reads one merge request", () => {
    const detail = parseDetail(
      mergeRequest({
        sha: "abc123",
        changes_count: "1000+",
        merge_when_pipeline_succeeds: true,
        detailed_merge_status: "ci_still_running",
      }),
      { ...context, facts: { additions: 5, deletions: 1, reviewDecision: "approved" } },
    );
    expect(detail).toMatchObject({
      provider: "gitlab",
      number: 12,
      body: "Fixes it.",
      headSha: "abc123",
      additions: 5,
      deletions: 1,
      changedFiles: 1000,
      autoMergeEnabled: true,
      reviewDecision: "approved",
      viewer: "bob",
      mergeMethods: ["merge"],
    });
  });

  it("leaves auto-merge unsaid when GitLab doesn't say", () => {
    expect(parseDetail(mergeRequest(), context)?.autoMergeEnabled).toBeUndefined();
    expect(
      parseDetail(mergeRequest({ merge_when_pipeline_succeeds: false }), context)?.autoMergeEnabled,
    ).toBe(false);
  });

  it("lets a stated review block outrank an approval", () => {
    expect(
      parseDetail(mergeRequest({ detailed_merge_status: "requested_changes" }), {
        ...context,
        facts: { additions: 0, deletions: 0, reviewDecision: "approved" },
      })?.reviewDecision,
    ).toBe("changes-requested");
  });

  it("sorts comments by time", () => {
    const comment = (id: string, createdAt: string) => ({
      id: id as never,
      kind: "issue-comment" as const,
      author: null,
      body: "x",
      createdAt: createdAt as never,
      url: null,
      path: null,
      reviewState: null,
    });
    const detail = parseDetail(mergeRequest(), {
      ...context,
      comments: [comment("2", "2026-10-30T10:00:00Z"), comment("1", "2026-10-30T09:00:00Z")],
    });
    expect(detail?.comments.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("drops an answer that isn't a merge request", () => {
    expect(parseDetail({ message: "404" }, context)).toBeNull();
  });
});

describe("parseDiffPage", () => {
  it("builds a unified diff with files, all unviewed", () => {
    const parsed = parseDiffPage([
      {
        old_path: "src/a.ts",
        new_path: "src/a.ts",
        diff: "@@ -1,2 +1,2 @@\n-old\n+new\n same\n",
      },
      {
        old_path: "src/new.ts",
        new_path: "src/new.ts",
        new_file: true,
        b_mode: "100755",
        diff: "@@ -0,0 +1 @@\n+hello",
      },
      {
        old_path: "gone.ts",
        new_path: "gone.ts",
        deleted_file: true,
        a_mode: "100644",
        diff: "@@ -1 +0,0 @@\n-bye\n",
      },
      { old_path: "before.ts", new_path: "after.ts", renamed_file: true, diff: "" },
    ]);
    expect(parsed.patch).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " same",
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100755",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1 @@",
        "+hello",
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/before.ts b/after.ts",
        "rename from before.ts",
        "rename to after.ts",
        "--- a/before.ts",
        "+++ b/after.ts",
        "",
      ].join("\n"),
    );
    expect(parsed.files).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 1, viewed: "unviewed" },
      { path: "src/new.ts", additions: 1, deletions: 0, viewed: "unviewed" },
      { path: "gone.ts", additions: 0, deletions: 1, viewed: "unviewed" },
      { path: "after.ts", additions: 0, deletions: 0, viewed: "unviewed" },
    ]);
    expect(parsed.incomplete).toBe(false);
    expect(parsed.rawCount).toBe(4);
  });

  it("flags a file GitLab held back", () => {
    expect(
      parseDiffPage([{ old_path: "a", new_path: "a", diff: "", too_large: true }]).incomplete,
    ).toBe(true);
    expect(
      parseDiffPage([{ old_path: "a", new_path: "a", diff: "", collapsed: true }]).incomplete,
    ).toBe(true);
  });

  it("quotes a path as Git would", () => {
    expect(parseDiffPage([{ old_path: 'a"b', new_path: 'a"b', diff: "" }]).patch).toContain(
      'diff --git "a/a\\"b" "b/a\\"b"',
    );
  });
});

describe("capabilities", () => {
  it("claims only what GitLab has", () => {
    expect(GITLAB_PULL_REQUEST_CAPABILITIES).toEqual({
      actions: [
        "merge",
        "enable-auto-merge",
        "disable-auto-merge",
        "approve",
        "ready",
        "close",
        "reopen",
      ],
      mergeMethods: ["merge", "squash", "rebase"],
      diff: true,
      comment: true,
      viewedFiles: false,
      mergeMessageRewrite: false,
      deleteBranch: true,
    });
    expect(GITLAB_PULL_REQUEST_CAPABILITIES.actions).not.toContain("revert");
    expect(fakeGitLab().host.setFileViewed).toBeUndefined();
  });
});

describe("buildMergeBody", () => {
  const action = { ...target, action: "merge" } as const;

  it("maps the choices", () => {
    expect(buildMergeBody({ ...action, mergeMethod: "squash", deleteBranch: true })).toEqual({
      squash: true,
      should_remove_source_branch: true,
    });
    expect(buildMergeBody({ ...action, mergeMethod: "merge", deleteBranch: false })).toEqual({
      squash: false,
      should_remove_source_branch: false,
    });
    expect(buildMergeBody({ ...target, action: "enable-auto-merge" })).toEqual({
      merge_when_pipeline_succeeds: true,
    });
  });
});

describe("runAction", () => {
  const run = async (input: Record<string, unknown>) => {
    const fake = fakeGitLab();
    await Effect.runPromise(fake.host.runAction({ ...target, action: "merge", ...input } as never));
    return fake.calls;
  };
  const jsonArgs = ["--input", "-", "--header", "Content-Type: application/json"];
  const path = `${encoded}/merge_requests/12`;

  it("merges through the API, with the body on stdin", async () => {
    const calls = await run({ action: "merge", mergeMethod: "squash", deleteBranch: true });
    expect(calls).toEqual([
      {
        args: ["api", `${path}/merge`, "--method", "PUT", ...jsonArgs],
        stdin: JSON.stringify({ squash: true, should_remove_source_branch: true }),
        host: "gitlab.example.com",
      },
    ]);
  });

  it("rebases first when that's the method", async () => {
    const calls = await run({ action: "merge", mergeMethod: "rebase" });
    expect(calls.map((call) => call.args[0])).toEqual(["mr", "api"]);
    expect(calls[0]?.args).toEqual(["mr", "rebase", "12", "--repo", "acme/platform/app"]);
  });

  it("arms and disarms auto-merge", async () => {
    const armed = await run({ action: "enable-auto-merge" });
    expect(armed[0]?.args[1]).toBe(`${path}/merge`);
    expect(armed[0]?.stdin).toBe(JSON.stringify({ merge_when_pipeline_succeeds: true }));
    const disarmed = await run({ action: "disable-auto-merge" });
    expect(disarmed[0]?.args).toEqual([
      "api",
      `${path}/cancel_merge_when_pipeline_succeeds`,
      "--method",
      "POST",
    ]);
  });

  it("approves", async () => {
    const calls = await run({ action: "approve" });
    expect(calls[0]?.args).toEqual(["api", `${path}/approve`, "--method", "POST"]);
  });

  it("marks ready through glab", async () => {
    const calls = await run({ action: "ready" });
    expect(calls[0]?.args).toEqual([
      "mr",
      "update",
      "12",
      "--repo",
      "acme/platform/app",
      "--ready",
    ]);
  });

  it.each([
    ["close", "close"],
    ["reopen", "reopen"],
  ])("%ss with a state event", async (action, event) => {
    const calls = await run({ action });
    expect(calls[0]?.args).toEqual(["api", path, "--method", "PUT", ...jsonArgs]);
    expect(calls[0]?.stdin).toBe(JSON.stringify({ state_event: event }));
  });

  it("refuses a revert rather than inventing one", async () => {
    const fake = fakeGitLab();
    const exit = await Effect.runPromiseExit(fake.host.runAction({ ...target, action: "revert" }));
    expect(exit._tag).toBe("Failure");
    expect(fake.calls).toEqual([]);
  });
});

describe("the host", () => {
  it("lists per project, with pipelines and line counts in one more read", async () => {
    const fake = fakeGitLab([
      ["api user", { username: "bob" }],
      [
        "api graphql",
        {
          data: {
            metadata: { enterprise: false },
            project: {
              mergeRequests: {
                nodes: [
                  {
                    iid: "12",
                    approved: true,
                    approvedBy: { nodes: [] },
                    diffStatsSummary: { additions: 3, deletions: 1 },
                    headPipeline: { status: "SUCCESS" },
                  },
                ],
              },
            },
          },
        },
      ],
      ["merge_requests?", [mergeRequest()]],
    ]);
    const list = await Effect.runPromise(
      fake.host.list({
        cwd: "/repo",
        repositories: ["acme/platform/app"],
        state: "open",
        involvement: "reviewing",
      }),
    );
    expect(list.viewer).toBe("bob");
    expect(list.truncated).toBe(false);
    expect(list.rows[0]).toMatchObject({ additions: 3, deletions: 1, checksState: "passing" });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.args[1]).toContain("reviewer_username=bob");
    const graphql = JSON.parse(fake.calls[2]?.stdin ?? "{}") as {
      variables: { fullPath: string; iids: ReadonlyArray<string> };
    };
    expect(graphql.variables).toEqual({ fullPath: "acme/platform/app", iids: ["12"] });
  });

  it("keeps the rows when the extra read fails, and says when the list is cut", async () => {
    const fake = fakeGitLab([
      ["api user", { username: "bob" }],
      ["api graphql", new GitLabCliError({ operation: "execute", detail: "boom" })],
      [
        "merge_requests?",
        Array.from({ length: 51 }, (_, index) => mergeRequest({ iid: index + 1 })),
      ],
    ]);
    const list = await Effect.runPromise(
      fake.host.list({
        cwd: "/repo",
        repositories: ["a/b"],
        state: "all",
        involvement: "all",
      }),
    );
    expect(list.rows).toHaveLength(50);
    expect(list.truncated).toBe(true);
    expect(list.rows[0]?.checksState).toBeUndefined();
  });

  it("reads a detail, with jobs from the pipeline's own project", async () => {
    const fake = fakeGitLab([
      ["api user", { username: "bob" }],
      ["api graphql", {}],
      ["/notes?", [{ id: 3, body: "Hi", created_at: "2026-10-30T09:00:00Z" }]],
      ["/commits?", [{ id: "aaa", title: "One", created_at: "2026-10-30T09:00:00Z" }]],
      ["/pipelines/77/jobs", [{ name: "unit", stage: "test", status: "success" }]],
      ["?license=false", { merge_method: "merge", squash_option: "default_off" }],
      [
        "merge_requests/12",
        mergeRequest({ head_pipeline: { id: 77, project_id: 900, status: "success" } }),
      ],
    ]);
    const detail = await Effect.runPromise(fake.host.detail(target));
    expect(detail.checks.map((check) => check.name)).toEqual(["test / unit"]);
    expect(detail.comments).toHaveLength(1);
    expect(detail.commits).toHaveLength(1);
    expect(detail.mergeMethods).toEqual(["merge", "squash"]);
    expect(fake.calls.some((call) => call.args[1]?.startsWith("projects/900/pipelines/77"))).toBe(
      true,
    );
  });

  it("falls back to the pipeline when its jobs can't be read", async () => {
    const fake = fakeGitLab([
      ["api user", { username: "bob" }],
      ["api graphql", {}],
      ["/notes?", []],
      ["/commits?", []],
      ["/pipelines/77/jobs", new GitLabCliError({ operation: "execute", detail: "403" })],
      ["?license=false", {}],
      [
        "merge_requests/12",
        mergeRequest({
          head_pipeline: { id: 77, project_id: 900, status: "failed", web_url: "https://p/77" },
        }),
      ],
    ]);
    const detail = await Effect.runPromise(fake.host.detail(target));
    expect(detail.checks).toEqual([
      { name: "Pipeline", status: "failure", description: null, url: "https://p/77" },
    ]);
  });

  it("empties the diff when a file was held back, keeping the file list", async () => {
    const fake = fakeGitLab([
      ["/diffs?", [{ old_path: "big", new_path: "big", diff: "", too_large: true }]],
    ]);
    const diff = await Effect.runPromise(fake.host.diff!(target));
    expect(diff).toEqual({
      diff: "",
      truncated: true,
      files: [{ path: "big", additions: 0, deletions: 0, viewed: "unviewed" }],
    });
  });

  it("stays under 30 a page on a merge request, and reads one commit from its own route", async () => {
    const fake = fakeGitLab([
      ["/diff?", [{ old_path: "a", new_path: "a", diff: "@@ -1 +1 @@\n-a\n+b\n" }]],
    ]);
    const diff = await Effect.runPromise(fake.host.diff!({ ...target, commit: "abc1234" }));
    expect(diff.truncated).toBe(false);
    expect(diff.diff).toContain("+b");
    expect(fake.calls[0]?.args[1]).toBe(
      `${encoded}/repository/commits/abc1234/diff?per_page=100&page=1`,
    );

    const whole = fakeGitLab([["/diffs?", []]]);
    await Effect.runPromise(whole.host.diff!(target));
    expect(whole.calls[0]?.args[1]).toBe(`${encoded}/merge_requests/12/diffs?per_page=30&page=1`);
  });

  it("sends a comment on stdin, not in the arguments", async () => {
    const fake = fakeGitLab();
    await Effect.runPromise(fake.host.comment!({ ...target, body: "--method DELETE; rm -rf /" }));
    expect(fake.calls[0]?.args.join(" ")).not.toContain("rm -rf");
    expect(fake.calls[0]?.stdin).toBe(JSON.stringify({ body: "--method DELETE; rm -rf /" }));
    expect(fake.calls[0]?.args[1]).toBe(`${encoded}/merge_requests/12/notes`);
  });
});
