/**
 * Dev mode's pull requests on GitHub, through `gh`: the token stays where
 * `gh auth login` put it and never appears in our arguments or logs.
 *
 * Fields follow upstream's `pullRequestListings.graphql` and
 * `pullRequestReads.graphql`. Actions use `gh pr …` where it has one, which also
 * picks the merge queue route for us. Revert and viewed marks have no command.
 *
 * @module sourceControl/gitHubPullRequestHost
 */
import {
  SourceControlProviderError,
  type PullRequestActor,
  type PullRequestCapabilities,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestDiffFile,
  type PullRequestFileViewedState,
  type PullRequestInvolvement,
  type PullRequestLabel,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestState,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { GitHubCliError, GitHubCliShape } from "./GitHubCli.ts";
import { removeAgentCredits } from "./mergeMessage.ts";
import type {
  PullRequestHostDetail,
  PullRequestHostRow,
  PullRequestHostShape,
} from "./pullRequestHost.ts";

/** `search` refuses a query past this many characters. */
const SEARCH_QUERY_MAX_CHARS = 256;
/** Each is one more search; past this the page says the list is cut. */
const MAX_SEARCHES = 6;
const ROWS_PER_SEARCH = 50;
const MAX_DIFF_BYTES = 8_000_000;
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 3;
const DIFF_TIMEOUT_MS = 60_000;

const ACTOR = `login avatarUrl __typename ... on User { name }`;

const ROW_FIELDS = `number title url author { ${ACTOR} } headRefName baseRefName state isDraft
  mergeable reviewDecision additions deletions createdAt updatedAt
  repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  labels(first: 20) { nodes { name color } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

export const LIST_QUERY = `query($q: String!, $first: Int!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: $first) {
    pageInfo { hasNextPage }
    nodes { ... on PullRequest { ${ROW_FIELDS} } }
  }
}`;

export const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $required: Boolean!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title url body state isDraft mergeable reviewDecision additions deletions
      changedFiles createdAt updatedAt mergedAt closedAt headRefName baseRefName headRefOid
      author { ${ACTOR} }
      autoMergeRequest { mergeMethod }
      labels(first: 20) { nodes { name color } }
      comments(last: 50) { nodes { id body createdAt lastEditedAt url author { ${ACTOR} } } }
      reviews(last: 50) {
        nodes {
          id body state submittedAt url author { ${ACTOR} }
          comments(first: 30) {
            nodes { id body path createdAt lastEditedAt url author { ${ACTOR} } }
          }
        }
      }
      allCommits: commits(last: 100) {
        nodes {
          commit {
            oid messageHeadline committedDate url
            authors(first: 3) { nodes { name user { login avatarUrl } } }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on StatusContext {
                    context state targetUrl description
                    isRequired(pullRequestNumber: $number) @include(if: $required)
                  }
                  ... on CheckRun {
                    name status conclusion detailsUrl title
                    isRequired(pullRequestNumber: $number) @include(if: $required)
                    checkSuite { workflowRun { workflow { name } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions viewerViewedState }
      }
    }
  }
}`;

const NODE_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

const MERGE_MESSAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $method: PullRequestMergeMethod!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      isMergeQueueEnabled
      viewerMergeBodyText(mergeType: $method)
    }
  }
}`;

const REVERT_MUTATION = `mutation($id: ID!) {
  revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { url } }
}`;

const SET_VIEWED_MUTATION = `mutation($id: ID!, $path: String!, $viewed: Boolean!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) @include(if: $viewed) {
    clientMutationId
  }
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) @skip(if: $viewed) {
    clientMutationId
  }
}`;

export const GITHUB_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
  actions: [
    "merge",
    "enable-auto-merge",
    "disable-auto-merge",
    "approve",
    "ready",
    "close",
    "reopen",
    "revert",
  ],
  mergeMethods: ["squash", "merge", "rebase"],
  diff: true,
  comment: true,
  viewedFiles: true,
  mergeMessageRewrite: true,
  deleteBranch: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const count = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);

const nodesOf = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  isRecord(value) && Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : [];

function actorOf(value: unknown): PullRequestActor | null {
  if (!isRecord(value)) return null;
  const login = text(value.login);
  if (login === null) return null;
  return {
    login: login as PullRequestActor["login"],
    name: text(value.name),
    avatarUrl: text(value.avatarUrl),
    ...(value.__typename === "Bot" ? { isBot: true } : {}),
  };
}

function labelsOf(value: unknown): ReadonlyArray<PullRequestLabel> {
  return nodesOf(value).flatMap((label) => {
    const name = text(label.name);
    return name === null
      ? []
      : [{ name: name as PullRequestLabel["name"], color: text(label.color) }];
  });
}

const stateOf = (value: unknown): PullRequestState =>
  value === "MERGED" ? "merged" : value === "CLOSED" ? "closed" : "open";

const mergeabilityOf = (value: unknown): PullRequestMergeability =>
  value === "MERGEABLE" ? "mergeable" : value === "CONFLICTING" ? "conflicting" : "unknown";

function reviewDecisionOf(value: unknown): PullRequestReviewDecision | undefined {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes-requested";
  if (value === "REVIEW_REQUIRED") return "review-required";
  return undefined;
}

function checksStateOf(value: unknown): PullRequestChecksState | undefined {
  if (value === "SUCCESS") return "passing";
  if (value === "FAILURE" || value === "ERROR") return "failing";
  if (value === "PENDING" || value === "EXPECTED") return "pending";
  return undefined;
}

function rollupStateOf(raw: Record<string, unknown>): unknown {
  const commit = nodesOf(raw.commits)[0]?.commit;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : null;
  return isRecord(rollup) ? rollup.state : null;
}

export function parseListRow(
  raw: Record<string, unknown>,
  host: string,
  viewer: string | null,
): PullRequestHostRow | null {
  const number = raw.number;
  const title = text(raw.title);
  const url = text(raw.url);
  const headBranch = text(raw.headRefName);
  const baseBranch = text(raw.baseRefName);
  const repository = isRecord(raw.repository) ? text(raw.repository.nameWithOwner) : null;
  const createdAt = text(raw.createdAt);
  const updatedAt = text(raw.updatedAt);
  if (
    typeof number !== "number" ||
    title === null ||
    url === null ||
    headBranch === null ||
    baseBranch === null ||
    repository === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const requested = nodesOf(raw.reviewRequests).some((request) => {
    const reviewer = request.requestedReviewer;
    return (
      viewer !== null &&
      isRecord(reviewer) &&
      text(reviewer.login)?.toLowerCase() === viewer.toLowerCase()
    );
  });
  const reviewDecision = reviewDecisionOf(raw.reviewDecision);
  const checksState = checksStateOf(rollupStateOf(raw));
  return {
    provider: "github",
    host: host as PullRequestHostRow["host"],
    repository: repository as PullRequestHostRow["repository"],
    number: number as PullRequestHostRow["number"],
    title: title as PullRequestHostRow["title"],
    url: url as PullRequestHostRow["url"],
    author: actorOf(raw.author),
    headBranch: headBranch as PullRequestHostRow["headBranch"],
    baseBranch: baseBranch as PullRequestHostRow["baseBranch"],
    state: stateOf(raw.state),
    isDraft: raw.isDraft === true,
    mergeability: mergeabilityOf(raw.mergeable),
    additions: count(raw.additions) as PullRequestHostRow["additions"],
    deletions: count(raw.deletions) as PullRequestHostRow["deletions"],
    createdAt,
    updatedAt,
    viewerReviewRequested: requested,
    labels: labelsOf(raw.labels),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(checksState !== undefined ? { checksState } : {}),
  };
}

const STATE_QUALIFIERS: Record<PullRequestListState, ReadonlyArray<string>> = {
  all: [],
  open: ["is:open"],
  closed: ["is:closed", "is:unmerged"],
  merged: ["is:merged"],
};

const INVOLVEMENT_QUALIFIERS: Record<PullRequestInvolvement, ReadonlyArray<string>> = {
  all: [],
  reviewing: ["review-requested:@me"],
  authored: ["author:@me"],
};

/**
 * GitHub's search takes at most 256 characters, so a long list of repositories
 * goes as several searches. What doesn't fit `MAX_SEARCHES` is reported as cut.
 */
export function buildSearchQueries(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly query?: string;
}): { readonly queries: ReadonlyArray<string>; readonly cut: boolean } {
  const fixed = [
    "is:pr",
    "sort:updated-desc",
    ...STATE_QUALIFIERS[input.state],
    ...INVOLVEMENT_QUALIFIERS[input.involvement],
    ...(input.query ? [input.query] : []),
  ].join(" ");
  const queries: string[] = [];
  let current = fixed;
  let inCurrent = 0;
  for (const repository of input.repositories) {
    const term = ` repo:${repository}`;
    if (current.length + term.length > SEARCH_QUERY_MAX_CHARS && inCurrent > 0) {
      queries.push(current);
      current = fixed;
      inCurrent = 0;
    }
    current += term;
    inCurrent += 1;
  }
  if (inCurrent > 0) queries.push(current);
  return { queries: queries.slice(0, MAX_SEARCHES), cut: queries.length > MAX_SEARCHES };
}

function checkStatusOf(raw: Record<string, unknown>): PullRequestCheckStatus {
  if (raw.__typename === "StatusContext") {
    if (raw.state === "SUCCESS") return "success";
    if (raw.state === "FAILURE" || raw.state === "ERROR") return "failure";
    return "pending";
  }
  if (raw.status !== "COMPLETED") return "pending";
  switch (raw.conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "ACTION_REQUIRED":
      return "action-required";
    case "SKIPPED":
      return "skipped";
    default:
      return "neutral";
  }
}

function checkOf(raw: Record<string, unknown>): PullRequestCheck | null {
  const statusContext = raw.__typename === "StatusContext";
  const run = text(raw.name);
  const suite = isRecord(raw.checkSuite) ? raw.checkSuite.workflowRun : null;
  const workflowName =
    isRecord(suite) && isRecord(suite.workflow) ? text(suite.workflow.name) : null;
  const name = statusContext
    ? text(raw.context)
    : workflowName !== null && run !== null
      ? `${workflowName} / ${run}`
      : run;
  if (name === null) return null;
  return {
    name: name as PullRequestCheck["name"],
    status: checkStatusOf(raw),
    description: text(statusContext ? raw.description : raw.title),
    url: text(statusContext ? raw.targetUrl : raw.detailsUrl),
    ...(typeof raw.isRequired === "boolean" ? { required: raw.isRequired } : {}),
  };
}

function commentsOf(pullRequest: Record<string, unknown>): ReadonlyArray<PullRequestComment> {
  const comments: PullRequestComment[] = [];
  for (const raw of nodesOf(pullRequest.comments)) {
    const id = text(raw.id);
    const createdAt = text(raw.createdAt);
    if (id === null || createdAt === null) continue;
    comments.push({
      id: id as PullRequestComment["id"],
      kind: "issue-comment",
      author: actorOf(raw.author),
      body: typeof raw.body === "string" ? raw.body : "",
      createdAt,
      editedAt: text(raw.lastEditedAt),
      url: text(raw.url),
      path: null,
      reviewState: null,
    });
  }
  for (const review of nodesOf(pullRequest.reviews)) {
    const id = text(review.id);
    const submittedAt = text(review.submittedAt);
    if (id === null || submittedAt === null) continue;
    const state = text(review.state);
    const body = typeof review.body === "string" ? review.body : "";
    // A bare "commented" with no words only frames its inline comments, listed below.
    if (body.trim().length > 0 || state !== "COMMENTED") {
      comments.push({
        id: id as PullRequestComment["id"],
        kind: "review",
        author: actorOf(review.author),
        body,
        createdAt: submittedAt,
        url: text(review.url),
        path: null,
        reviewState: state?.toLowerCase().replaceAll("_", " ") ?? null,
      });
    }
    for (const raw of nodesOf(review.comments)) {
      const commentId = text(raw.id);
      const createdAt = text(raw.createdAt);
      if (commentId === null || createdAt === null) continue;
      comments.push({
        id: commentId as PullRequestComment["id"],
        kind: "review-comment",
        author: actorOf(raw.author),
        body: typeof raw.body === "string" ? raw.body : "",
        createdAt,
        editedAt: text(raw.lastEditedAt),
        url: text(raw.url),
        path: text(raw.path),
        reviewState: null,
      });
    }
  }
  return comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function commitsOf(pullRequest: Record<string, unknown>): ReadonlyArray<PullRequestCommit> {
  return nodesOf(pullRequest.allCommits).flatMap((node) => {
    const commit = node.commit;
    if (!isRecord(commit)) return [];
    const oid = text(commit.oid);
    const committedDate = text(commit.committedDate);
    if (oid === null || committedDate === null) return [];
    const authors = nodesOf(commit.authors).flatMap((author) => {
      const user = isRecord(author.user) ? author.user : null;
      const login = text(user?.login) ?? text(author.name);
      return login === null
        ? []
        : [
            {
              login: login as PullRequestActor["login"],
              name: text(author.name),
              avatarUrl: text(user?.avatarUrl),
            },
          ];
    });
    return [
      {
        oid: oid as PullRequestCommit["oid"],
        messageHeadline: typeof commit.messageHeadline === "string" ? commit.messageHeadline : "",
        committedDate,
        authors,
        url: text(commit.url),
      },
    ];
  });
}

export function parseDetail(
  repository: Record<string, unknown>,
  viewer: string | null,
  host: string,
  nameWithOwner: string,
): PullRequestHostDetail | null {
  const raw = repository.pullRequest;
  if (!isRecord(raw)) return null;
  const number = raw.number;
  const title = text(raw.title);
  const url = text(raw.url);
  const headBranch = text(raw.headRefName);
  const baseBranch = text(raw.baseRefName);
  const createdAt = text(raw.createdAt);
  const updatedAt = text(raw.updatedAt);
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
  const headCommit = nodesOf(raw.commits)[0]?.commit;
  const rollup = isRecord(headCommit) ? headCommit.statusCheckRollup : null;
  const checks = nodesOf(isRecord(rollup) ? rollup.contexts : null).flatMap((context) => {
    const check = checkOf(context);
    return check === null ? [] : [check];
  });
  const reviewDecision = reviewDecisionOf(raw.reviewDecision);
  const mergeMethods: PullRequestMergeMethod[] = [
    ...(repository.squashMergeAllowed === false ? [] : (["squash"] as const)),
    ...(repository.mergeCommitAllowed === false ? [] : (["merge"] as const)),
    ...(repository.rebaseMergeAllowed === false ? [] : (["rebase"] as const)),
  ];
  return {
    provider: "github",
    host: host as PullRequestHostDetail["host"],
    repository: nameWithOwner as PullRequestHostDetail["repository"],
    number: number as PullRequestHostDetail["number"],
    title: title as PullRequestHostDetail["title"],
    body: typeof raw.body === "string" ? raw.body : "",
    url: url as PullRequestHostDetail["url"],
    author: actorOf(raw.author),
    state: stateOf(raw.state),
    isDraft: raw.isDraft === true,
    mergeability: mergeabilityOf(raw.mergeable),
    additions: count(raw.additions) as PullRequestHostDetail["additions"],
    deletions: count(raw.deletions) as PullRequestHostDetail["deletions"],
    changedFiles: count(raw.changedFiles) as PullRequestHostDetail["changedFiles"],
    headBranch: headBranch as PullRequestHostDetail["headBranch"],
    headSha: text(raw.headRefOid) as PullRequestHostDetail["headSha"],
    baseBranch: baseBranch as PullRequestHostDetail["baseBranch"],
    createdAt,
    updatedAt,
    mergedAt: text(raw.mergedAt),
    closedAt: text(raw.closedAt),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    labels: labelsOf(raw.labels),
    checks,
    autoMergeEnabled: isRecord(raw.autoMergeRequest),
    ...(viewer !== null ? { viewer: viewer as NonNullable<PullRequestHostDetail["viewer"]> } : {}),
    comments: commentsOf(raw),
    commits: commitsOf(raw),
    mergeMethods,
  };
}

const VIEWED_STATES: Record<string, PullRequestFileViewedState> = {
  VIEWED: "viewed",
  DISMISSED: "changed",
  UNVIEWED: "unviewed",
};

export function parseFilesPage(raw: Record<string, unknown>): {
  readonly files: ReadonlyArray<PullRequestDiffFile>;
  readonly nextCursor: string | null;
} {
  const pullRequest = isRecord(raw.pullRequest) ? raw.pullRequest : null;
  const connection = isRecord(pullRequest?.files) ? pullRequest.files : null;
  const pageInfo = isRecord(connection?.pageInfo) ? connection.pageInfo : null;
  return {
    files: nodesOf(connection).flatMap((file) => {
      const path = text(file.path);
      return path === null
        ? []
        : [
            {
              path: path as PullRequestDiffFile["path"],
              additions: count(file.additions) as PullRequestDiffFile["additions"],
              deletions: count(file.deletions) as PullRequestDiffFile["deletions"],
              viewed: VIEWED_STATES[String(file.viewerViewedState)] ?? "unviewed",
            },
          ];
    }),
    nextCursor: pageInfo?.hasNextPage === true ? text(pageInfo.endCursor) : null,
  };
}

/** GitHub refuses a diff past 300 files or 20,000 lines; the page then links to the site. */
const isDiffTooLarge = (detail: string) =>
  /too_large|too large|exceeded the maximum number of (lines|files)|not available/iu.test(detail);

const MERGE_FLAGS: Record<PullRequestMergeMethod, string> = {
  merge: "--merge",
  squash: "--squash",
  rebase: "--rebase",
};

export function makeGitHubPullRequestHost(
  github: GitHubCliShape,
  hostname: string,
): PullRequestHostShape {
  const providerError = (operation: string) => (cause: GitHubCliError) =>
    new SourceControlProviderError({
      provider: "github",
      operation,
      detail: cause.detail,
      cause,
    });

  /** `gh` takes `HOST/owner/name` for an Enterprise server. */
  const repoFlag = (repository: string) =>
    hostname === "github.com" ? repository : `${hostname}/${repository}`;

  const ownerName = (repository: string) => {
    const [owner = "", name = ""] = repository.split("/");
    return { owner, name };
  };

  const graphql = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly query: string;
    /** `-f`: stays a string, so a value like `@file` is never read as a file. */
    readonly strings?: Readonly<Record<string, string>>;
    /** `-F`: numbers and booleans. */
    readonly typed?: Readonly<Record<string, number | boolean>>;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "--hostname",
          hostname,
          "-f",
          `query=${input.query}`,
          ...Object.entries(input.strings ?? {}).flatMap(([key, value]) => [
            "-f",
            `${key}=${value}`,
          ]),
          ...Object.entries(input.typed ?? {}).flatMap(([key, value]) => [
            "-F",
            `${key}=${value}`,
          ]),
        ],
      })
      .pipe(
        Effect.mapError(providerError(input.operation)),
        Effect.flatMap((result) =>
          Effect.try({
            try: () => JSON.parse(result.stdout) as unknown,
            catch: () =>
              new SourceControlProviderError({
                provider: "github",
                operation: input.operation,
                detail: "GitHub answered with something that isn't JSON.",
              }),
          }),
        ),
        Effect.flatMap((parsed): Effect.Effect<Record<string, unknown>, SourceControlProviderError> => {
          const data = isRecord(parsed) ? parsed.data : null;
          return isRecord(data)
            ? Effect.succeed(data)
            : Effect.fail(
                new SourceControlProviderError({
                  provider: "github",
                  operation: input.operation,
                  detail: "GitHub sent no data.",
                }),
              );
        }),
      );

  const repositoryOf = (
    data: Record<string, unknown>,
    operation: string,
  ): Effect.Effect<Record<string, unknown>, SourceControlProviderError> =>
    isRecord(data.repository)
      ? Effect.succeed(data.repository)
      : Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation,
            detail: "GitHub doesn't show this repository.",
          }),
        );

  const nodeId = (input: Parameters<PullRequestHostShape["detail"]>[0], operation: string) =>
    graphql({
      cwd: input.cwd,
      operation,
      query: NODE_ID_QUERY,
      strings: ownerName(input.repository),
      typed: { number: input.number },
    }).pipe(
      Effect.flatMap((data) => repositoryOf(data, operation)),
      Effect.flatMap((repository): Effect.Effect<string, SourceControlProviderError> => {
        const pullRequest = repository.pullRequest;
        const id = isRecord(pullRequest) ? text(pullRequest.id) : null;
        return id !== null
          ? Effect.succeed(id)
          : Effect.fail(
              new SourceControlProviderError({
                provider: "github",
                operation,
                detail: "Pull request not found.",
              }),
            );
      }),
    );

  const cli = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    github.execute({ cwd, args }).pipe(Effect.mapError(providerError(operation)), Effect.asVoid);

  /** The body GitHub would use, without agent credits; null when there's nothing to remove. */
  const cleanedMergeBody = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly method: PullRequestMergeMethod;
  }) =>
    graphql({
      cwd: input.cwd,
      operation: "mergeMessage",
      query: MERGE_MESSAGE_QUERY,
      strings: {
        ...ownerName(input.repository),
        method: input.method === "squash" ? "SQUASH" : "MERGE",
      },
      typed: { number: input.number },
    }).pipe(
      Effect.flatMap((data) => repositoryOf(data, "mergeMessage")),
      Effect.map((repository) => {
        const pullRequest = isRecord(repository.pullRequest) ? repository.pullRequest : null;
        const body = pullRequest?.viewerMergeBodyText;
        // A merge queue chooses its own message and ignores ours.
        if (typeof body !== "string" || pullRequest?.isMergeQueueEnabled === true) return null;
        const cleaned = removeAgentCredits(body);
        const headSha = text(pullRequest?.headRefOid);
        return cleaned === body || headSha === null ? null : { body: cleaned, headSha };
      }),
    );

  const mergeArgs = (input: Parameters<PullRequestHostShape["runAction"]>[0]) =>
    Effect.gen(function* () {
      const method = input.mergeMethod ?? "squash";
      // Rebase keeps each commit's message: there's no merge commit to clean.
      const cleaned =
        input.removeAgentCredits === true && method !== "rebase"
          ? yield* cleanedMergeBody({
              cwd: input.cwd,
              repository: input.repository,
              number: input.number,
              method,
            })
          : null;
      return [
        "pr",
        "merge",
        String(input.number),
        "--repo",
        repoFlag(input.repository),
        MERGE_FLAGS[method],
        ...(input.action === "enable-auto-merge" ? ["--auto"] : []),
        ...(input.deleteBranch === true ? ["--delete-branch"] : []),
        ...(cleaned !== null
          ? ["--body", cleaned.body, "--match-head-commit", cleaned.headSha]
          : []),
      ];
    });

  return {
    label: "GitHub",
    capabilities: GITHUB_PULL_REQUEST_CAPABILITIES,

    list: (input) => {
      const { queries, cut } = buildSearchQueries(input);
      return Effect.forEach(
        queries,
        (q) =>
          graphql({
            cwd: input.cwd,
            operation: "listPullRequests",
            query: LIST_QUERY,
            strings: { q },
            typed: { first: ROWS_PER_SEARCH },
          }),
        { concurrency: 2 },
      ).pipe(
        Effect.map((answers) => {
          let viewer: string | null = null;
          let truncated = cut;
          const rows = new Map<string, PullRequestHostRow>();
          for (const data of answers) {
            const login = isRecord(data.viewer) ? text(data.viewer.login) : null;
            viewer = viewer ?? login;
            const search = isRecord(data.search) ? data.search : null;
            if (isRecord(search?.pageInfo) && search.pageInfo.hasNextPage === true) {
              truncated = true;
            }
            for (const node of nodesOf(search)) {
              const row = parseListRow(node, hostname, viewer);
              if (row !== null) rows.set(`${row.repository}#${row.number}`, row);
            }
          }
          return {
            viewer,
            rows: [...rows.values()].map((row) =>
              input.involvement === "reviewing" ? { ...row, viewerReviewRequested: true } : row,
            ),
            truncated,
          };
        }),
      );
    },

    detail: (input) =>
      graphql({
        cwd: input.cwd,
        operation: "getPullRequestDetail",
        query: DETAIL_QUERY,
        strings: ownerName(input.repository),
        typed: { number: input.number, required: hostname === "github.com" },
      }).pipe(
        Effect.flatMap((data) =>
          repositoryOf(data, "getPullRequestDetail").pipe(
            Effect.flatMap((repository): Effect.Effect<PullRequestHostDetail, SourceControlProviderError> => {
              const viewer = isRecord(data.viewer) ? text(data.viewer.login) : null;
              const detail = parseDetail(repository, viewer, hostname, input.repository);
              return detail !== null
                ? Effect.succeed(detail)
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: "github",
                      operation: "getPullRequestDetail",
                      detail: "Pull request not found.",
                    }),
                  );
            }),
          ),
        ),
      ),

    diff: (input) =>
      Effect.gen(function* () {
        const { owner, name } = ownerName(input.repository);
        const files: PullRequestDiffFile[] = [];
        let after: string | null = null;
        for (let page = 0; page < MAX_FILE_PAGES; page += 1) {
          const data: Record<string, unknown> = yield* graphql({
            cwd: input.cwd,
            operation: "getPullRequestFiles",
            query: FILES_QUERY,
            strings: { owner, name, ...(after !== null ? { after } : {}) },
            typed: { number: input.number, first: FILES_PER_PAGE },
          });
          const repository: Record<string, unknown> = yield* repositoryOf(
            data,
            "getPullRequestFiles",
          );
          const parsed = parseFilesPage(repository);
          files.push(...parsed.files);
          after = parsed.nextCursor;
          if (after === null) break;
        }
        const read = yield* github
          .execute({
            cwd: input.cwd,
            args:
              input.commit !== undefined
                ? [
                    "api",
                    "--hostname",
                    hostname,
                    "-H",
                    "Accept: application/vnd.github.diff",
                    `repos/${owner}/${name}/commits/${input.commit}`,
                  ]
                : [
                    "pr",
                    "diff",
                    String(input.number),
                    "--repo",
                    repoFlag(input.repository),
                    "--color",
                    "never",
                  ],
            timeoutMs: DIFF_TIMEOUT_MS,
            maxOutputBytes: MAX_DIFF_BYTES,
            truncateOutputAtMaxBytes: true,
          })
          .pipe(
            Effect.map((result) => ({
              diff: result.stdoutTruncated ? "" : result.stdout,
              truncated: result.stdoutTruncated,
            })),
            Effect.catch((error) =>
              isDiffTooLarge(error.detail)
                ? Effect.succeed({ diff: "", truncated: true })
                : Effect.fail(providerError("getPullRequestDiff")(error)),
            ),
          );
        return { ...read, files };
      }),

    runAction: (input) =>
      Effect.gen(function* () {
        const target = [String(input.number), "--repo", repoFlag(input.repository)];
        const operation = `pullRequest.${input.action}`;
        switch (input.action) {
          case "merge":
          case "enable-auto-merge":
            yield* cli(input.cwd, operation, yield* mergeArgs(input));
            return { url: null };
          case "disable-auto-merge":
            yield* cli(input.cwd, operation, ["pr", "merge", ...target, "--disable-auto"]);
            return { url: null };
          case "approve":
            yield* cli(input.cwd, operation, ["pr", "review", ...target, "--approve"]);
            return { url: null };
          case "ready":
            yield* cli(input.cwd, operation, ["pr", "ready", ...target]);
            return { url: null };
          case "close":
            yield* cli(input.cwd, operation, ["pr", "close", ...target]);
            return { url: null };
          case "reopen":
            yield* cli(input.cwd, operation, ["pr", "reopen", ...target]);
            return { url: null };
          case "revert": {
            const id = yield* nodeId(input, operation);
            const data = yield* graphql({
              cwd: input.cwd,
              operation,
              query: REVERT_MUTATION,
              strings: { id },
            });
            const made = isRecord(data.revertPullRequest)
              ? data.revertPullRequest.revertPullRequest
              : null;
            return { url: isRecord(made) ? text(made.url) : null };
          }
        }
      }),

    setFileViewed: (input) =>
      nodeId(input, "setFileViewed").pipe(
        Effect.flatMap((id) =>
          graphql({
            cwd: input.cwd,
            operation: "setFileViewed",
            query: SET_VIEWED_MUTATION,
            strings: { id, path: input.path },
            typed: { viewed: input.viewed },
          }),
        ),
        Effect.asVoid,
      ),

    comment: (input) =>
      cli(input.cwd, "commentOnPullRequest", [
        "pr",
        "comment",
        String(input.number),
        "--repo",
        repoFlag(input.repository),
        "--body",
        input.body,
      ]),
  };
}
