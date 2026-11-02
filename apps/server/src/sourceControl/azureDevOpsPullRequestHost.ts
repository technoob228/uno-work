/**
 * Dev mode's pull requests on Azure DevOps, through `az` and its azure-devops
 * extension: the sign-in stays where `az login` or `az devops login` put it.
 *
 * Commands as the extension documents them: `az repos pr list/show/update/set-vote`
 * and `az repos pr policy list` for the checks. Threads and commits have no `az`
 * command, so they're read with `az devops invoke` (GET only) and a refusal there
 * costs only them. What `az` can't do is not offered: rebase merges (the CLI
 * completes with squash or a merge commit), revert, viewed marks, a diff (the REST
 * API has no unified diff) and comments (a write through `invoke` needs a file).
 *
 * @module sourceControl/azureDevOpsPullRequestHost
 */
import {
  SourceControlProviderError,
  type PullRequestActor,
  type PullRequestCapabilities,
  type PullRequestCheck,
  type PullRequestCheckStatus,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestInvolvement,
  type PullRequestLabel,
  type PullRequestListState,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestState,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { AzureDevOpsCliError, AzureDevOpsCliShape } from "./AzureDevOpsCli.ts";
import {
  isRecord,
  text,
  type PullRequestHostActionInput,
  type PullRequestHostDetail,
  type PullRequestHostRow,
  type PullRequestHostShape,
  type PullRequestHostTarget,
} from "./pullRequestHost.ts";

const MAX_PROJECTS = 20;
const ROWS_PER_REPOSITORY = 50;
/** Each `az` call starts Python; more at once only queues on the machine. */
const REQUEST_CONCURRENCY = 3;
/** Completing is queued on Azure's side; it's read back this often, this many times. */
const COMPLETE_POLL_MS = 2_000;
const COMPLETE_POLL_ATTEMPTS = 5;
const EMPTY_ID = "00000000-0000-0000-0000-000000000000";

export const AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
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
};

const STATUS_PARAMS: Record<PullRequestListState, string> = {
  all: "all",
  open: "active",
  closed: "abandoned",
  merged: "completed",
};

export interface AzureRepository {
  /** What `--org` takes: `https://dev.azure.com/org`, or a server's collection. */
  readonly organizationUrl: string;
  readonly project: string;
  readonly name: string;
}

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * The repository path from a remote, as `parseRemoteRepositoryPath` gives it:
 * `org/project/_git/repo` on dev.azure.com, `[collection/]project/_git/repo` on
 * `org.visualstudio.com` or a server, `v3/org/project/repo` over SSH, and
 * `org/_git/repo` for a project named as its repository.
 */
export function parseAzureRepository(hostname: string, repository: string): AzureRepository | null {
  const host = hostname.toLowerCase();
  const parts = repository
    .split("/")
    .filter((part) => part.length > 0)
    .map(decoded);
  if (parts[0] === "v3" && parts.length === 4) {
    const [, organization, project, name] = parts as [string, string, string, string];
    const organizationUrl = host.endsWith(".visualstudio.com")
      ? `https://${organization}.visualstudio.com`
      : `https://dev.azure.com/${encodeURIComponent(organization)}`;
    return { organizationUrl, project, name };
  }
  const git = parts.indexOf("_git");
  if (git < 0 || git !== parts.length - 2) return null;
  const name = parts[git + 1]!;
  const before = parts.slice(0, git);
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com") {
    if (before.length === 0 || before.length > 2) return null;
    const [organization, project = name] = before as [string, string?];
    return {
      organizationUrl: `https://dev.azure.com/${encodeURIComponent(organization)}`,
      project,
      name,
    };
  }
  const project = before.length > 0 ? before.at(-1)! : name;
  const collection = before.slice(0, -1).map(encodeURIComponent).join("/");
  return {
    organizationUrl: `https://${host}${collection.length > 0 ? `/${collection}` : ""}`,
    project,
    name,
  };
}

const branchName = (ref: unknown) => text(ref)?.replace(/^refs\/heads\//u, "") ?? null;

/** Avatars on Azure need the sign-in to load, so none are passed on. */
function actorOf(value: unknown): PullRequestActor | null {
  if (!isRecord(value)) return null;
  const login = text(value.uniqueName) ?? text(value.displayName);
  if (login === null) return null;
  return {
    login: login as PullRequestActor["login"],
    name: text(value.displayName),
    avatarUrl: null,
  };
}

function stateOf(value: unknown): PullRequestState {
  if (value === "completed") return "merged";
  return value === "abandoned" ? "closed" : "open";
}

function mergeabilityOf(value: unknown): PullRequestMergeability {
  if (value === "conflicts") return "conflicting";
  return value === "succeeded" ? "mergeable" : "unknown";
}

const reviewersOf = (raw: Record<string, unknown>) =>
  Array.isArray(raw.reviewers) ? (raw.reviewers as ReadonlyArray<unknown>).filter(isRecord) : [];

const voteOf = (reviewer: Record<string, unknown>) =>
  typeof reviewer.vote === "number" ? reviewer.vote : 0;

/**
 * Votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for the
 * author, -10 rejected. A required reviewer who hasn't approved keeps it in review.
 */
export function reviewDecisionOf(
  raw: Record<string, unknown>,
): PullRequestReviewDecision | undefined {
  const reviewers = reviewersOf(raw).filter((reviewer) => reviewer.isContainer !== true);
  if (reviewers.length === 0) return undefined;
  if (reviewers.some((reviewer) => voteOf(reviewer) < 0)) return "changes-requested";
  const requiredPending = reviewers.some(
    (reviewer) => reviewer.isRequired === true && voteOf(reviewer) < 5,
  );
  if (!requiredPending && reviewers.some((reviewer) => voteOf(reviewer) >= 5)) return "approved";
  return "review-required";
}

function labelsOf(value: unknown): ReadonlyArray<PullRequestLabel> {
  if (!Array.isArray(value)) return [];
  return (value as ReadonlyArray<unknown>).filter(isRecord).flatMap((label) => {
    const name = text(label.name);
    return name === null || label.active === false
      ? []
      : [{ name: name as PullRequestLabel["name"], color: null }];
  });
}

/** The repository's page: Azure's own link when it sends one. */
export function repositoryWebUrl(
  raw: Record<string, unknown>,
  repository: AzureRepository,
): string {
  const site = isRecord(raw.repository) ? text(raw.repository.webUrl) : null;
  return (
    site ??
    `${repository.organizationUrl}/${encodeURIComponent(repository.project)}/_git/${encodeURIComponent(repository.name)}`
  );
}

export function webUrlOf(raw: Record<string, unknown>, repository: AzureRepository): string {
  return `${repositoryWebUrl(raw, repository)}/pullrequest/${String(raw.pullRequestId)}`;
}

export function parseListRow(
  raw: Record<string, unknown>,
  context: {
    readonly host: string;
    readonly repository: string;
    readonly target: AzureRepository;
    readonly viewerIsReviewer?: boolean;
  },
): PullRequestHostRow | null {
  const number = raw.pullRequestId;
  const title = text(raw.title);
  const headBranch = branchName(raw.sourceRefName);
  const baseBranch = branchName(raw.targetRefName);
  const createdAt = text(raw.creationDate);
  if (
    typeof number !== "number" ||
    title === null ||
    headBranch === null ||
    baseBranch === null ||
    createdAt === null
  ) {
    return null;
  }
  const reviewDecision = reviewDecisionOf(raw);
  return {
    provider: "azure-devops",
    host: context.host as PullRequestHostRow["host"],
    repository: context.repository as PullRequestHostRow["repository"],
    number: number as PullRequestHostRow["number"],
    title: title as PullRequestHostRow["title"],
    url: webUrlOf(raw, context.target) as PullRequestHostRow["url"],
    author: actorOf(raw.createdBy),
    headBranch: headBranch as PullRequestHostRow["headBranch"],
    baseBranch: baseBranch as PullRequestHostRow["baseBranch"],
    state: stateOf(raw.status),
    isDraft: raw.isDraft === true,
    mergeability: mergeabilityOf(raw.mergeStatus),
    // Azure keeps no line counts on a pull request.
    additions: 0 as PullRequestHostRow["additions"],
    deletions: 0 as PullRequestHostRow["deletions"],
    createdAt,
    // Nor a time of last change: closing is the last one it records.
    updatedAt: text(raw.closedDate) ?? createdAt,
    viewerReviewRequested: context.viewerIsReviewer === true,
    labels: labelsOf(raw.labels),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
  };
}

function policyStatusOf(status: unknown): PullRequestCheckStatus {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "notApplicable":
      return "skipped";
    default:
      return "pending";
  }
}

/** Branch policies as checks: builds, reviewers, linked work items, and the like. */
export function parsePolicies(
  raw: unknown,
  target: AzureRepository,
): ReadonlyArray<PullRequestCheck> {
  if (!Array.isArray(raw)) return [];
  return (raw as ReadonlyArray<unknown>).filter(isRecord).flatMap((evaluation) => {
    const configuration = isRecord(evaluation.configuration) ? evaluation.configuration : null;
    if (configuration?.isEnabled === false) return [];
    const settings = isRecord(configuration?.settings) ? configuration.settings : null;
    const type = isRecord(configuration?.type) ? configuration.type : null;
    const name = text(settings?.displayName) ?? text(type?.displayName);
    if (name === null) return [];
    const context = isRecord(evaluation.context) ? evaluation.context : null;
    const buildId = typeof context?.buildId === "number" ? context.buildId : null;
    return [
      {
        name: name as PullRequestCheck["name"],
        status: policyStatusOf(evaluation.status),
        description: text(type?.displayName) === name ? null : text(type?.displayName),
        url:
          buildId !== null
            ? `${target.organizationUrl}/${encodeURIComponent(target.project)}/_build/results?buildId=${buildId}`
            : null,
        required: configuration?.isBlocking === true,
      },
    ];
  });
}

/** Text comments of live threads; Azure's own notes ("system") are its timeline. */
export function parseThreads(
  raw: unknown,
  pullRequestUrl: string,
): ReadonlyArray<PullRequestComment> {
  const threads = isRecord(raw) && Array.isArray(raw.value) ? raw.value : [];
  return (threads as ReadonlyArray<unknown>).filter(isRecord).flatMap((thread) => {
    if (thread.isDeleted === true) return [];
    const context = isRecord(thread.threadContext) ? thread.threadContext : null;
    const path = text(context?.filePath)?.replace(/^\//u, "") ?? null;
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    return (comments as ReadonlyArray<unknown>).filter(isRecord).flatMap((comment) => {
      const body = typeof comment.content === "string" ? comment.content : "";
      const createdAt = text(comment.publishedDate);
      if (
        typeof comment.id !== "number" ||
        createdAt === null ||
        comment.isDeleted === true ||
        comment.commentType === "system" ||
        body.trim().length === 0
      ) {
        return [];
      }
      return [
        {
          id: `${String(thread.id)}:${comment.id}` as PullRequestComment["id"],
          kind: path === null ? ("issue-comment" as const) : ("review-comment" as const),
          author: actorOf(comment.author),
          body,
          createdAt,
          editedAt: text(comment.lastContentUpdatedDate),
          url: typeof thread.id === "number" ? `${pullRequestUrl}?discussionId=${thread.id}` : null,
          path,
          reviewState: null,
        },
      ];
    });
  });
}

/** Azure lists a pull request's commits newest first; the page reads oldest first. */
export function parseCommits(
  raw: unknown,
  repositoryUrl: string | null = null,
): ReadonlyArray<PullRequestCommit> {
  const commits = isRecord(raw) && Array.isArray(raw.value) ? raw.value : [];
  return (commits as ReadonlyArray<unknown>)
    .filter(isRecord)
    .flatMap((commit) => {
      const oid = text(commit.commitId);
      const author = isRecord(commit.author) ? commit.author : null;
      const committedDate =
        (isRecord(commit.committer) ? text(commit.committer.date) : null) ?? text(author?.date);
      if (oid === null || committedDate === null) return [];
      const login = text(author?.email) ?? text(author?.name);
      return [
        {
          oid: oid as PullRequestCommit["oid"],
          messageHeadline: (typeof commit.comment === "string" ? commit.comment : "").split(
            "\n",
          )[0]!,
          committedDate,
          authors:
            login === null
              ? []
              : [
                  {
                    login: login as PullRequestActor["login"],
                    name: text(author?.name),
                    avatarUrl: null,
                  },
                ],
          url:
            text(commit.remoteUrl) ??
            (repositoryUrl !== null ? `${repositoryUrl}/commit/${oid}` : null),
        },
      ];
    })
    .toReversed();
}

export function parseDetail(
  raw: Record<string, unknown>,
  context: {
    readonly host: string;
    readonly repository: string;
    readonly target: AzureRepository;
    readonly checks: ReadonlyArray<PullRequestCheck>;
    readonly comments: ReadonlyArray<PullRequestComment>;
    readonly commits: ReadonlyArray<PullRequestCommit>;
  },
): PullRequestHostDetail | null {
  const row = parseListRow(raw, context);
  if (row === null) return null;
  const closedAt = text(raw.closedDate);
  const autoCompleteBy = isRecord(raw.autoCompleteSetBy) ? text(raw.autoCompleteSetBy.id) : null;
  const headSha = isRecord(raw.lastMergeSourceCommit)
    ? text(raw.lastMergeSourceCommit.commitId)
    : null;
  return {
    provider: "azure-devops",
    host: row.host,
    repository: row.repository,
    number: row.number,
    title: row.title,
    body: typeof raw.description === "string" ? raw.description : "",
    url: row.url,
    author: row.author,
    state: row.state,
    isDraft: row.isDraft,
    mergeability: row.mergeability,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: 0 as PullRequestHostDetail["changedFiles"],
    headBranch: row.headBranch,
    headSha: headSha as PullRequestHostDetail["headSha"],
    baseBranch: row.baseBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mergedAt: row.state === "merged" ? closedAt : null,
    closedAt: row.state === "closed" ? closedAt : null,
    ...(row.reviewDecision !== undefined ? { reviewDecision: row.reviewDecision } : {}),
    labels: row.labels,
    checks: context.checks,
    autoMergeEnabled: autoCompleteBy !== null && autoCompleteBy !== EMPTY_ID,
    comments: context.comments.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    commits: context.commits,
    mergeMethods: AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES.mergeMethods,
  };
}

export function buildListArgs(input: {
  readonly target: AzureRepository;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
}): ReadonlyArray<string> {
  return [
    "repos",
    "pr",
    "list",
    "--org",
    input.target.organizationUrl,
    "--project",
    input.target.project,
    "--repository",
    input.target.name,
    "--status",
    STATUS_PARAMS[input.state],
    "--top",
    String(ROWS_PER_REPOSITORY + 1),
    // The extension reads `me` as whoever `az` is signed in as.
    ...(input.involvement === "authored" ? ["--creator", "me"] : []),
    ...(input.involvement === "reviewing" ? ["--reviewer", "me"] : []),
  ];
}

/** `az repos pr update` for an action; merge and auto-complete carry the completion choices. */
export function buildUpdateArgs(
  input: PullRequestHostActionInput,
  organizationUrl: string,
): ReadonlyArray<string> | null {
  const base = ["repos", "pr", "update", "--id", String(input.number), "--org", organizationUrl];
  const completion = [
    ...(input.mergeMethod !== undefined
      ? ["--squash", input.mergeMethod === "squash" ? "true" : "false"]
      : []),
    ...(input.deleteBranch !== undefined
      ? ["--delete-source-branch", input.deleteBranch ? "true" : "false"]
      : []),
  ];
  switch (input.action) {
    case "merge":
      return [...base, "--status", "completed", ...completion];
    case "enable-auto-merge":
      return [...base, "--auto-complete", "true", ...completion];
    case "disable-auto-merge":
      return [...base, "--auto-complete", "false"];
    case "ready":
      return [...base, "--draft", "false"];
    case "close":
      return [...base, "--status", "abandoned"];
    case "reopen":
      return [...base, "--status", "active"];
    default:
      return null;
  }
}

/**
 * What `az` printed, as the person reads it: its `ERROR:` line without the prefix.
 * Azure's messages are sentences ("TF401027: You need the Git 'PullRequestContribute'
 * permission…"), so they stand as they are.
 */
export function azureRefusal(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const error = lines.find((line) => line.startsWith("ERROR:")) ?? lines.at(-1) ?? null;
  const line = error?.replace(/^ERROR:\s*/u, "").trim() ?? "";
  return line.length > 0 ? line : null;
}

/** After a completion is queued: done, held back, or still going. */
export function completionOutcome(raw: unknown): "done" | "pending" | string {
  if (!isRecord(raw)) return "pending";
  if (raw.status === "completed") return "done";
  if (raw.status === "abandoned") return "The pull request was abandoned.";
  const failure = text(raw.mergeFailureMessage);
  if (raw.mergeStatus === "conflicts") {
    return "Azure DevOps can't complete this: the branch has conflicts.";
  }
  if (raw.mergeStatus === "rejectedByPolicy") {
    return "Azure DevOps can't complete this yet: a branch policy hasn't passed.";
  }
  if (raw.mergeStatus === "failure") return failure ?? "Azure DevOps couldn't merge the branch.";
  return "pending";
}

export function makeAzureDevOpsPullRequestHost(
  azure: Pick<AzureDevOpsCliShape, "execute">,
  hostname: string,
  options: { readonly completePollMs?: number; readonly completePollAttempts?: number } = {},
): PullRequestHostShape {
  const failure = (operation: string, detail: string) =>
    new SourceControlProviderError({ provider: "azure-devops", operation, detail });

  /** `AzureDevOpsCli` leads with the error's tag; the person needs `az`'s own line. */
  const providerError = (operation: string) => (cause: AzureDevOpsCliError) => {
    const process = isRecord(cause.cause) ? cause.cause : null;
    const output = typeof process?.detail === "string" ? process.detail : null;
    const own =
      output !== null && process?._tag === "VcsProcessExitError" ? azureRefusal(output) : null;
    // Kept as the CLI read it when that reading is "not signed in" or "no tool".
    const keep = /not authenticated|not available on path/iu.test(cause.detail);
    return new SourceControlProviderError({
      provider: "azure-devops",
      operation,
      detail: keep || own === null ? cause.detail : own,
      cause,
    });
  };

  const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    azure
      .execute({ cwd, args: [...args, "--only-show-errors", "--output", "json"] })
      .pipe(Effect.mapError(providerError(operation)));

  const readJson = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    run(cwd, operation, args).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () =>
            result.stdout.trim().length === 0 ? null : (JSON.parse(result.stdout) as unknown),
          catch: () => failure(operation, "Azure DevOps answered with something that isn't JSON."),
        }),
      ),
    );

  const targetOf = (operation: string, repository: string) => {
    const target = parseAzureRepository(hostname, repository);
    return target !== null
      ? Effect.succeed(target)
      : Effect.fail(failure(operation, "This doesn't look like an Azure DevOps repository."));
  };

  /** `invoke` for the reads `az repos pr` has no command for; a refusal costs only them. */
  const invoke = (
    cwd: string,
    target: AzureRepository,
    resource: "pullRequestThreads" | "pullRequestCommits",
    number: number,
  ) =>
    readJson(cwd, `read.${resource}`, [
      "devops",
      "invoke",
      "--org",
      target.organizationUrl,
      "--area",
      "git",
      "--resource",
      resource,
      "--route-parameters",
      `project=${target.project}`,
      `repositoryId=${target.name}`,
      `pullRequestId=${number}`,
      "--http-method",
      "GET",
    ]).pipe(
      Effect.catch(() =>
        Effect.logWarning("azure devops: pull request read skipped").pipe(
          Effect.annotateLogs({ resource }),
          Effect.as(null),
        ),
      ),
    );

  const policies = (cwd: string, target: AzureRepository, number: number) =>
    readJson(cwd, "readPolicies", [
      "repos",
      "pr",
      "policy",
      "list",
      "--id",
      String(number),
      "--org",
      target.organizationUrl,
    ]).pipe(
      Effect.map((raw) => parsePolicies(raw, target)),
      Effect.orElseSucceed((): ReadonlyArray<PullRequestCheck> => []),
    );

  const show = (input: PullRequestHostTarget, target: AzureRepository, operation: string) =>
    readJson(input.cwd, operation, [
      "repos",
      "pr",
      "show",
      "--id",
      String(input.number),
      "--org",
      target.organizationUrl,
    ]);

  /** A completion is queued on Azure's side; it's read back until it lands or says why not. */
  const awaitCompletion = (
    input: PullRequestHostActionInput,
    target: AzureRepository,
    operation: string,
    first: unknown,
  ) =>
    Effect.gen(function* () {
      let answer = first;
      const attempts = options.completePollAttempts ?? COMPLETE_POLL_ATTEMPTS;
      for (let attempt = 0; ; attempt += 1) {
        const outcome = completionOutcome(answer);
        if (outcome === "done") return;
        if (outcome !== "pending") return yield* failure(operation, outcome);
        if (attempt >= attempts) {
          // Azure holds a completion while a required policy hasn't passed, without saying so.
          const checks = yield* policies(input.cwd, target, input.number);
          const holding = checks.find(
            (check) =>
              check.required === true && check.status !== "success" && check.status !== "skipped",
          );
          return yield* failure(
            operation,
            holding !== undefined
              ? `Azure DevOps is waiting on "${holding.name}". Auto-complete merges it once that passes.`
              : "Azure DevOps is still completing this. Reload in a minute.",
          );
        }
        yield* Effect.sleep(options.completePollMs ?? COMPLETE_POLL_MS);
        answer = yield* show(input, target, operation);
      }
    });

  return {
    label: "Azure DevOps",
    capabilities: AZURE_DEVOPS_PULL_REQUEST_CAPABILITIES,

    list: (input) =>
      Effect.gen(function* () {
        const operation = "listPullRequests";
        const needle = input.query?.toLowerCase() ?? null;
        const answers = yield* Effect.forEach(
          input.repositories.slice(0, MAX_PROJECTS),
          (repository) => {
            const target = parseAzureRepository(hostname, repository);
            if (target === null) return Effect.succeed({ rows: [], truncated: false });
            return readJson(
              input.cwd,
              operation,
              buildListArgs({ target, state: input.state, involvement: input.involvement }),
            ).pipe(
              Effect.map((raw) => {
                const all = Array.isArray(raw)
                  ? (raw as ReadonlyArray<unknown>).filter(isRecord)
                  : [];
                const rows = all.slice(0, ROWS_PER_REPOSITORY).flatMap((entry) => {
                  // `az repos pr list` has no search; the words are looked for here.
                  if (
                    needle !== null &&
                    !`${text(entry.title) ?? ""}\n${text(entry.description) ?? ""}`
                      .toLowerCase()
                      .includes(needle)
                  ) {
                    return [];
                  }
                  const row = parseListRow(entry, {
                    host: hostname,
                    repository,
                    target,
                    viewerIsReviewer: input.involvement === "reviewing",
                  });
                  return row === null ? [] : [row];
                });
                return { rows, truncated: all.length > ROWS_PER_REPOSITORY };
              }),
            );
          },
          { concurrency: REQUEST_CONCURRENCY },
        );
        return {
          // `az` doesn't say who it's signed in as without one more call per list.
          viewer: null,
          rows: answers.flatMap((answer) => answer.rows),
          truncated:
            input.repositories.length > MAX_PROJECTS || answers.some((answer) => answer.truncated),
        };
      }),

    detail: (input) =>
      Effect.gen(function* () {
        const operation = "getPullRequestDetail";
        const target = yield* targetOf(operation, input.repository);
        const [raw, checks, threads, commits] = yield* Effect.all(
          [
            show(input, target, operation),
            policies(input.cwd, target, input.number),
            invoke(input.cwd, target, "pullRequestThreads", input.number),
            invoke(input.cwd, target, "pullRequestCommits", input.number),
          ],
          { concurrency: REQUEST_CONCURRENCY },
        );
        if (!isRecord(raw)) return yield* failure(operation, "Pull request not found.");
        const url = webUrlOf(raw, target);
        const detail = parseDetail(raw, {
          host: hostname,
          repository: input.repository,
          target,
          checks,
          comments: parseThreads(threads, url),
          commits: parseCommits(commits, repositoryWebUrl(raw, target)),
        });
        return detail !== null ? detail : yield* failure(operation, "Pull request not found.");
      }),

    runAction: (input) =>
      Effect.gen(function* () {
        const operation = `pullRequest.${input.action}`;
        const target = yield* targetOf(operation, input.repository);
        if (input.action === "approve") {
          yield* run(input.cwd, operation, [
            "repos",
            "pr",
            "set-vote",
            "--id",
            String(input.number),
            "--vote",
            "approve",
            "--org",
            target.organizationUrl,
          ]);
          return { url: null };
        }
        const args = buildUpdateArgs(input, target.organizationUrl);
        if (args === null)
          return yield* failure(operation, "Azure DevOps doesn't have this action.");
        const answer = yield* readJson(input.cwd, operation, args);
        if (input.action === "merge") yield* awaitCompletion(input, target, operation, answer);
        return { url: null };
      }),
  };
}
