/**
 * Dev mode's pull requests on Bitbucket Cloud, through the REST API with the
 * credentials saved for the Bitbucket provider. They stay inside `BitbucketApi`,
 * which also refuses to follow a link off the API's own origin.
 *
 * Fields follow upstream's `BitbucketPullRequestApi.ts` and `bitbucketPullRequestJson.ts`.
 * Bitbucket can merge, approve and decline. It has no auto-merge, no draft-to-ready,
 * no reopen of a declined pull request, no revert and no viewed marks on files.
 * Its listings carry no sizes or builds, and a read per row would eat the hourly
 * limit, so rows show those only once opened.
 *
 * @module sourceControl/bitbucketPullRequestHost
 */
import {
  SourceControlProviderError,
  type PullRequestActor,
  type PullRequestCapabilities,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestDiffFile,
  type PullRequestInvolvement,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestReviewDecision,
  type PullRequestState,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { BitbucketApiError, BitbucketApiShape } from "./BitbucketApi.ts";
import {
  count,
  isRecord,
  text,
  type PullRequestHostActionInput,
  type PullRequestHostDetail,
  type PullRequestHostRow,
  type PullRequestHostShape,
  type PullRequestHostTarget,
} from "./pullRequestHost.ts";

/** Bitbucket answers an empty page above this size rather than an error. */
const PAGE_SIZE = 50;
const MAX_PROJECTS = 20;
const REQUEST_CONCURRENCY = 3;
const MAX_CONVERSATION_PAGES = 3;
/** 300 files, as GitHub's own limit. */
const MAX_DIFFSTAT_PAGES = 6;
const MAX_DIFF_BYTES = 8_000_000;

export const BITBUCKET_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  actions: ["merge", "approve", "close"],
  mergeMethods: ["merge", "squash", "rebase"],
  diff: true,
  comment: true,
  viewedFiles: false,
  mergeMessageRewrite: false,
  deleteBranch: true,
};

const MERGE_STRATEGIES: Record<PullRequestMergeMethod, string> = {
  merge: "merge_commit",
  squash: "squash",
  rebase: "rebase_fast_forward",
};

const STATE_PARAMS: Record<PullRequestListState, ReadonlyArray<string>> = {
  all: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
  open: ["OPEN"],
  closed: ["DECLINED", "SUPERSEDED"],
  merged: ["MERGED"],
};

export interface BitbucketViewer {
  readonly login: string;
  readonly uuid: string | null;
}

/** `workspace/slug`; anything else is not a Bitbucket repository. */
export function repositoryPath(repository: string): string | null {
  const parts = repository.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) return null;
  return `/repositories/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`;
}

/** The backslash goes first, or escaping the quote would leave a live quote behind it. */
const filterLiteral = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export function buildListPath(input: {
  readonly repository: string;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: BitbucketViewer | null;
  readonly query?: string;
}): string | null {
  const path = repositoryPath(input.repository);
  if (path === null) return null;
  const uuid = input.viewer?.uuid ?? null;
  const predicates = [
    ...(input.query ? [`(title ~ "${filterLiteral(input.query)}" OR description ~ "${filterLiteral(input.query)}")`] : []),
    ...(input.involvement === "authored" && uuid !== null
      ? [`author.uuid = "${filterLiteral(uuid)}"`]
      : []),
    ...(input.involvement === "reviewing" && uuid !== null
      ? [`reviewers.uuid = "${filterLiteral(uuid)}"`]
      : []),
  ];
  const params = [
    ...STATE_PARAMS[input.state].map((state) => `state=${state}`),
    `pagelen=${PAGE_SIZE}`,
    "sort=-updated_on",
    // Listings leave reviewers and votes out unless asked.
    `fields=${encodeURIComponent("+values.reviewers,+values.participants")}`,
    ...(predicates.length > 0 ? [`q=${encodeURIComponent(predicates.join(" AND "))}`] : []),
  ];
  return `${path}/pullrequests?${params.join("&")}`;
}

/** Bitbucket keeps microseconds and a `+00:00` offset; the page sorts ISO strings. */
function isoOf(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** App accounts have no nickname; their display name stands in. */
function actorOf(value: unknown): PullRequestActor | null {
  if (!isRecord(value)) return null;
  const login = text(value.nickname) ?? text(value.display_name);
  if (login === null) return null;
  const links = isRecord(value.links) ? value.links : null;
  const avatar = isRecord(links?.avatar) ? links.avatar : null;
  return {
    login: login as PullRequestActor["login"],
    name: text(value.display_name),
    avatarUrl: text(avatar?.href),
    ...(value.type === "app_user" ? { isBot: true } : {}),
  };
}

function stateOf(value: unknown): PullRequestState {
  if (value === "MERGED") return "merged";
  return value === "DECLINED" || value === "SUPERSEDED" ? "closed" : "open";
}

const recordsOf = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? (value as ReadonlyArray<unknown>).filter(isRecord) : [];

const branchOf = (side: unknown) => {
  const record = isRecord(side) ? side : null;
  return {
    name: isRecord(record?.branch) ? text(record.branch.name) : null,
    branch: isRecord(record?.branch) ? record.branch : null,
    sha: isRecord(record?.commit) ? text(record.commit.hash) : null,
  };
};

function reviewDecisionOf(raw: Record<string, unknown>): PullRequestReviewDecision | undefined {
  const participants = recordsOf(raw.participants);
  if (participants.some((participant) => participant.state === "changes_requested")) {
    return "changes-requested";
  }
  if (
    participants.some(
      (participant) => participant.state === "approved" || participant.approved === true,
    )
  ) {
    return "approved";
  }
  return recordsOf(raw.reviewers).length > 0 ? "review-required" : undefined;
}

export function parseListRow(
  raw: Record<string, unknown>,
  host: string,
  repository: string,
  viewer: BitbucketViewer | null,
): PullRequestHostRow | null {
  const number = raw.id;
  const title = text(raw.title);
  const url = isRecord(raw.links) && isRecord(raw.links.html) ? text(raw.links.html.href) : null;
  const headBranch = branchOf(raw.source).name;
  const baseBranch = branchOf(raw.destination).name;
  const createdAt = isoOf(raw.created_on);
  const updatedAt = isoOf(raw.updated_on);
  if (
    typeof number !== "number" ||
    title === null ||
    url === null ||
    headBranch === null ||
    baseBranch === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const reviewDecision = reviewDecisionOf(raw);
  return {
    provider: "bitbucket",
    host: host as PullRequestHostRow["host"],
    repository: repository as PullRequestHostRow["repository"],
    number: number as PullRequestHostRow["number"],
    title: title as PullRequestHostRow["title"],
    url: url as PullRequestHostRow["url"],
    author: actorOf(raw.author),
    headBranch: headBranch as PullRequestHostRow["headBranch"],
    baseBranch: baseBranch as PullRequestHostRow["baseBranch"],
    state: stateOf(raw.state),
    isDraft: raw.draft === true,
    // Listings don't say; the conflicts read is one more request per row.
    mergeability: "unknown",
    additions: 0 as PullRequestHostRow["additions"],
    deletions: 0 as PullRequestHostRow["deletions"],
    createdAt,
    updatedAt,
    viewerReviewRequested:
      viewer !== null &&
      recordsOf(raw.reviewers).some((reviewer) =>
        viewer.uuid !== null && text(reviewer.uuid) !== null
          ? reviewer.uuid === viewer.uuid
          : actorOf(reviewer)?.login.toLowerCase() === viewer.login.toLowerCase(),
      ),
    // Bitbucket has no labels.
    labels: [],
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
  };
}

function checkStatusOf(state: unknown): PullRequestCheckStatus {
  switch (state) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "STOPPED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

/** A rerun reuses its key; the later status is the one that counts. */
export function parseStatuses(values: ReadonlyArray<unknown>): ReadonlyArray<PullRequestCheck> {
  const byKey = new Map<string, PullRequestCheck>();
  for (const status of recordsOf(values)) {
    const name = text(status.name) ?? text(status.key);
    if (name === null) continue;
    byKey.set(text(status.key) ?? name, {
      name: name as PullRequestCheck["name"],
      status: checkStatusOf(status.state),
      description: text(status.description),
      url: text(status.url),
    });
  }
  return [...byKey.values()];
}

/** Deleted and unsent (pending) comments are left out, as on the site. */
export function parseComments(values: ReadonlyArray<unknown>): ReadonlyArray<PullRequestComment> {
  return recordsOf(values).flatMap((comment) => {
    const content = isRecord(comment.content) ? comment.content : null;
    const body = typeof content?.raw === "string" ? content.raw : "";
    const createdAt = isoOf(comment.created_on);
    if (
      typeof comment.id !== "number" ||
      createdAt === null ||
      comment.deleted === true ||
      comment.pending === true ||
      body.trim().length === 0
    ) {
      return [];
    }
    const path = isRecord(comment.inline) ? text(comment.inline.path) : null;
    const links = isRecord(comment.links) ? comment.links : null;
    return [
      {
        id: String(comment.id) as PullRequestComment["id"],
        kind: path === null ? ("issue-comment" as const) : ("review-comment" as const),
        author: actorOf(comment.user),
        body,
        createdAt,
        url: isRecord(links?.html) ? text(links.html.href) : null,
        path,
        reviewState: null,
      },
    ];
  });
}

/** Votes have no text, but who approved and when belongs in the timeline. */
export function parseReviews(raw: Record<string, unknown>): ReadonlyArray<PullRequestComment> {
  return recordsOf(raw.participants).flatMap((participant) => {
    const author = actorOf(participant.user);
    const votedAt = isoOf(participant.participated_on);
    const state =
      text(participant.state) ?? (participant.approved === true ? "approved" : null);
    if (author === null || votedAt === null || state === null) return [];
    return [
      {
        id: `${String(raw.id)}:${author.login}` as PullRequestComment["id"],
        kind: "review" as const,
        author,
        body: "",
        createdAt: votedAt,
        url: null,
        path: null,
        reviewState: state.replaceAll("_", " "),
      },
    ];
  });
}

/** Bitbucket lists commits newest first; the page reads oldest first. */
export function parseCommits(values: ReadonlyArray<unknown>): ReadonlyArray<PullRequestCommit> {
  return recordsOf(values)
    .flatMap((commit) => {
      const oid = text(commit.hash);
      const committedDate = isoOf(commit.date);
      if (oid === null || committedDate === null) return [];
      const author = isRecord(commit.author) ? commit.author : null;
      const linked = actorOf(author?.user);
      const rawAuthor = text(author?.raw);
      const links = isRecord(commit.links) ? commit.links : null;
      return [
        {
          oid: oid as PullRequestCommit["oid"],
          messageHeadline: (typeof commit.message === "string" ? commit.message : "").split(
            "\n",
          )[0]!,
          committedDate,
          authors:
            linked !== null
              ? [linked]
              : rawAuthor !== null
                ? [{ login: rawAuthor as PullRequestActor["login"], name: rawAuthor, avatarUrl: null }]
                : [],
          url: isRecord(links?.html) ? text(links.html.href) : null,
        },
      ];
    })
    .toReversed();
}

export function parseDiffstat(values: ReadonlyArray<unknown>): ReadonlyArray<PullRequestDiffFile> {
  return recordsOf(values).flatMap((entry) => {
    const path =
      (isRecord(entry.new) ? text(entry.new.path) : null) ??
      (isRecord(entry.old) ? text(entry.old.path) : null);
    return path === null
      ? []
      : [
          {
            path: path as PullRequestDiffFile["path"],
            additions: count(entry.lines_added) as PullRequestDiffFile["additions"],
            deletions: count(entry.lines_removed) as PullRequestDiffFile["deletions"],
            viewed: "unviewed" as const,
          },
        ];
  });
}

/** The target branch names the strategies it allows; older answers don't, so all stand. */
export function parseMergeMethods(raw: Record<string, unknown>): ReadonlyArray<PullRequestMergeMethod> {
  const all = BITBUCKET_PULL_REQUEST_CAPABILITIES.mergeMethods;
  const allowed = branchOf(raw.destination).branch?.merge_strategies;
  if (!Array.isArray(allowed) || allowed.length === 0) return all;
  return all.filter((method) => allowed.includes(MERGE_STRATEGIES[method]));
}

export function parseDetail(
  raw: Record<string, unknown>,
  context: {
    readonly host: string;
    readonly repository: string;
    readonly viewer: BitbucketViewer | null;
    readonly files: ReadonlyArray<PullRequestDiffFile>;
    readonly conflicts: boolean | null;
    readonly checks: ReadonlyArray<PullRequestCheck>;
    readonly comments: ReadonlyArray<PullRequestComment>;
    readonly commits: ReadonlyArray<PullRequestCommit>;
  },
): PullRequestHostDetail | null {
  const row = parseListRow(raw, context.host, context.repository, context.viewer);
  if (row === null) return null;
  const closedOn = isoOf(raw.closed_on);
  const sum = (key: "additions" | "deletions") =>
    context.files.reduce((total, file) => total + file[key], 0);
  return {
    provider: "bitbucket",
    host: row.host,
    repository: row.repository,
    number: row.number,
    title: row.title,
    body: typeof raw.description === "string" ? raw.description : "",
    url: row.url,
    author: row.author,
    state: row.state,
    isDraft: row.isDraft,
    mergeability:
      context.conflicts === null ? "unknown" : context.conflicts ? "conflicting" : "mergeable",
    additions: sum("additions") as PullRequestHostDetail["additions"],
    deletions: sum("deletions") as PullRequestHostDetail["deletions"],
    changedFiles: context.files.length as PullRequestHostDetail["changedFiles"],
    headBranch: row.headBranch,
    headSha: branchOf(raw.source).sha as PullRequestHostDetail["headSha"],
    baseBranch: row.baseBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mergedAt: row.state === "merged" ? closedOn : null,
    closedAt: row.state === "closed" ? closedOn : null,
    ...(row.reviewDecision !== undefined ? { reviewDecision: row.reviewDecision } : {}),
    labels: [],
    checks: context.checks,
    ...(context.viewer !== null
      ? { viewer: context.viewer.login as NonNullable<PullRequestHostDetail["viewer"]> }
      : {}),
    comments: [...context.comments, ...parseReviews(raw)].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    commits: context.commits,
    mergeMethods: parseMergeMethods(raw),
  };
}

/** Left out unless picked, so the branch's default strategy and setting apply. */
export function buildMergeBody(input: PullRequestHostActionInput): Record<string, unknown> {
  return {
    ...(input.mergeMethod !== undefined
      ? { merge_strategy: MERGE_STRATEGIES[input.mergeMethod] }
      : {}),
    ...(input.deleteBranch !== undefined ? { close_source_branch: input.deleteBranch } : {}),
  };
}

export function makeBitbucketPullRequestHost(
  bitbucket: Pick<BitbucketApiShape, "request">,
  hostname: string,
): PullRequestHostShape {
  const failure = (operation: string, detail: string) =>
    new SourceControlProviderError({ provider: "bitbucket", operation, detail });

  // The page reads these words: Settings for credentials, "nothing there" for a 404.
  const providerError = (operation: string) => (cause: BitbucketApiError) =>
    new SourceControlProviderError({
      provider: "bitbucket",
      operation,
      detail:
        cause.status === 401
          ? "Bitbucket is not authenticated: its credentials are missing or refused."
          : cause.status === 404
            ? "Bitbucket: not found."
            : cause.detail,
      cause,
    });

  const call = (input: {
    readonly operation: string;
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly body?: unknown;
    readonly maxBytes?: number;
  }) => bitbucket.request(input).pipe(Effect.mapError(providerError(input.operation)));

  const readJson = (operation: string, url: string) =>
    call({ operation, method: "GET", url }).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () => JSON.parse(result.body) as unknown,
          catch: () => failure(operation, "Bitbucket answered with something that isn't JSON."),
        }),
      ),
    );

  /** Follows `next` links; the API keeps them on its own origin. */
  const readPages = (operation: string, url: string, maxPages: number) =>
    Effect.gen(function* () {
      const values: unknown[] = [];
      let next: string | null = url;
      for (let page = 0; page < maxPages && next !== null; page += 1) {
        const answer: unknown = yield* readJson(operation, next);
        values.push(...(isRecord(answer) && Array.isArray(answer.values) ? answer.values : []));
        next = isRecord(answer) ? text(answer.next) : null;
      }
      return { values, truncated: next !== null };
    });

  // One account per server, so the answer holds for as long as this host does.
  let viewer: BitbucketViewer | null = null;
  const viewerOf = (operation: string) =>
    viewer !== null
      ? Effect.succeed(viewer)
      : readJson(operation, "/user").pipe(
          Effect.flatMap((user) => {
            const login = isRecord(user) ? (text(user.nickname) ?? text(user.display_name)) : null;
            if (login === null) {
              return Effect.fail(failure(operation, "Bitbucket didn't say who is signed in."));
            }
            viewer = { login, uuid: isRecord(user) ? text(user.uuid) : null };
            return Effect.succeed(viewer);
          }),
        );

  const pathOf = (operation: string, repository: string) => {
    const path = repositoryPath(repository);
    return path !== null
      ? Effect.succeed(path)
      : Effect.fail(failure(operation, "A Bitbucket repository is workspace/name."));
  };

  // Only these two say nothing about the pull request itself; a refusal on them shouldn't blank it.
  const optional = <A>(read: Effect.Effect<A, SourceControlProviderError>, fallback: A) =>
    read.pipe(
      Effect.catch((error) => {
        const status = (error.cause as BitbucketApiError | undefined)?.status;
        return status === 401 || status === 429 ? Effect.fail(error) : Effect.succeed(fallback);
      }),
    );

  return {
    label: "Bitbucket",
    capabilities: BITBUCKET_PULL_REQUEST_CAPABILITIES,

    list: (input) =>
      Effect.gen(function* () {
        const operation = "listPullRequests";
        const signedIn = yield* viewerOf(operation);
        if (input.involvement !== "all" && signedIn.uuid === null) {
          return yield* failure(operation, "Bitbucket didn't say who is signed in.");
        }
        const answers = yield* Effect.forEach(
          input.repositories.slice(0, MAX_PROJECTS),
          (repository) => {
            const url = buildListPath({
              repository,
              state: input.state,
              involvement: input.involvement,
              viewer: signedIn,
              ...(input.query !== undefined ? { query: input.query } : {}),
            });
            if (url === null) return Effect.succeed({ rows: [], truncated: false });
            return readJson(operation, url).pipe(
              Effect.map((answer) => ({
                rows: recordsOf(isRecord(answer) ? answer.values : null).flatMap((raw) => {
                  const row = parseListRow(raw, hostname, repository, signedIn);
                  return row === null ? [] : [row];
                }),
                truncated: isRecord(answer) && text(answer.next) !== null,
              })),
            );
          },
          { concurrency: REQUEST_CONCURRENCY },
        );
        return {
          viewer: signedIn.login,
          rows: answers.flatMap((answer) => answer.rows),
          truncated:
            input.repositories.length > MAX_PROJECTS || answers.some((answer) => answer.truncated),
        };
      }),

    detail: (input) =>
      Effect.gen(function* () {
        const operation = "getPullRequestDetail";
        const path = yield* pathOf(operation, input.repository);
        const pullRequest = `${path}/pullrequests/${input.number}`;
        const [signedIn, raw, files, conflicts, statuses, comments, commits] = yield* Effect.all(
          [
            viewerOf(operation),
            // `closed_on` is left out unless asked.
            readJson(operation, `${pullRequest}?fields=${encodeURIComponent("+closed_on")}`),
            readPages(operation, `${pullRequest}/diffstat?pagelen=${PAGE_SIZE}`, MAX_DIFFSTAT_PAGES),
            optional(
              readJson(operation, `${pullRequest}/conflicts`).pipe(
                Effect.map((answer): boolean | null =>
                  isRecord(answer) && Array.isArray(answer.values)
                    ? answer.values.length > 0
                    : null,
                ),
              ),
              null,
            ),
            optional(
              readPages(operation, `${pullRequest}/statuses?pagelen=${PAGE_SIZE}`, 2),
              { values: [], truncated: false },
            ),
            readPages(
              operation,
              `${pullRequest}/comments?pagelen=${PAGE_SIZE}&sort=-created_on`,
              MAX_CONVERSATION_PAGES,
            ),
            readPages(operation, `${pullRequest}/commits?pagelen=${PAGE_SIZE}`, 2),
          ],
          { concurrency: REQUEST_CONCURRENCY },
        );
        const detail = isRecord(raw)
          ? parseDetail(raw, {
              host: hostname,
              repository: input.repository,
              viewer: signedIn,
              files: parseDiffstat(files.values),
              // A merged or declined one has nothing left to conflict with.
              conflicts: stateOf(raw.state) === "open" ? conflicts : null,
              checks: parseStatuses(statuses.values),
              comments: parseComments(comments.values),
              commits: parseCommits(commits.values),
            })
          : null;
        return detail !== null ? detail : yield* failure(operation, "Pull request not found.");
      }),

    diff: (input: PullRequestHostTarget & { readonly commit?: string }) =>
      Effect.gen(function* () {
        const operation = "getPullRequestDiff";
        const path = yield* pathOf(operation, input.repository);
        const route = (kind: "diff" | "diffstat") =>
          input.commit === undefined
            ? `${path}/pullrequests/${input.number}/${kind}`
            : `${path}/${kind}/${encodeURIComponent(input.commit)}`;
        const [stats, patch] = yield* Effect.all(
          [
            readPages(operation, `${route("diffstat")}?pagelen=${PAGE_SIZE}`, MAX_DIFFSTAT_PAGES),
            call({ operation, method: "GET", url: route("diff"), maxBytes: MAX_DIFF_BYTES }),
          ],
          { concurrency: 2 },
        );
        const truncated = patch.truncated || stats.truncated;
        return { diff: truncated ? "" : patch.body, files: parseDiffstat(stats.values), truncated };
      }),

    runAction: (input) =>
      Effect.gen(function* () {
        const operation = `pullRequest.${input.action}`;
        const path = yield* pathOf(operation, input.repository);
        const pullRequest = `${path}/pullrequests/${input.number}`;
        switch (input.action) {
          case "merge":
            yield* call({
              operation,
              method: "POST",
              url: `${pullRequest}/merge`,
              body: buildMergeBody(input),
            });
            return { url: null };
          case "approve":
            yield* call({ operation, method: "POST", url: `${pullRequest}/approve` });
            return { url: null };
          case "close":
            yield* call({ operation, method: "POST", url: `${pullRequest}/decline` });
            return { url: null };
          default:
            return yield* failure(operation, "Bitbucket doesn't have this action.");
        }
      }),

    comment: (input) =>
      Effect.gen(function* () {
        const operation = "commentOnPullRequest";
        const path = yield* pathOf(operation, input.repository);
        yield* call({
          operation,
          method: "POST",
          url: `${path}/pullrequests/${input.number}/comments`,
          body: { content: { raw: input.body } },
        });
      }),
  };
}
