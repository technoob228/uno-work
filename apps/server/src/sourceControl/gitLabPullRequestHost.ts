/**
 * Dev mode's merge requests on GitLab, through `glab api`: the token stays where
 * `glab auth login` put it and never appears in our arguments or logs. Request
 * bodies go over stdin, so a comment isn't on anyone's process list either.
 *
 * Fields follow upstream's `GitLabPullRequestCli.ts` and `gitLabMergeRequestJson.ts`.
 * REST reads the rows; line counts, approvals and head pipelines come from one
 * GraphQL read per project, because REST would need a request per row for them.
 * GitLab has no revert command and keeps viewed marks in the browser, so neither
 * is offered.
 *
 * @module sourceControl/gitLabPullRequestHost
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
  type PullRequestInvolvement,
  type PullRequestLabel,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestState,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { GitLabCliError, GitLabCliShape } from "./GitLabCli.ts";
import { gitLabChecks } from "./gitLabMergeRequests.ts";
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

/** Each project costs two requests a list; past this the page says the list is cut. */
const MAX_PROJECTS = 20;
const ROWS_PER_PROJECT = 50;
/** GitLab allows 2000 requests a minute; this is what the status reads already use. */
const REQUEST_CONCURRENCY = 3;
const PAGE_SIZE = 100;
const MAX_NOTE_PAGES = 3;
/** GitLab 15.7 through 17.10 answer a merge request's `/diffs` with a 500 above 30 a page. */
const MERGE_REQUEST_DIFF_PAGE_SIZE = 30;
const COMMIT_DIFF_PAGE_SIZE = 100;
const MAX_DIFF_PAGES = 10;
const MAX_DIFF_BYTES = 8_000_000;
const DIFF_TIMEOUT_MS = 60_000;
/** `glab mr rebase` waits for GitLab to finish, which can outlast a read. */
const REBASE_TIMEOUT_MS = 120_000;

export const GITLAB_PULL_REQUEST_CAPABILITIES: PullRequestCapabilities = {
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
};

/** `iids` holds at most a page of rows, and a page is what this connection answers. */
export const ROW_FACTS_QUERY = `query($fullPath: ID!, $iids: [String!]) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes {
        iid approved
        approvedBy(first: 1) { nodes { username } }
        diffStatsSummary { additions deletions }
        headPipeline { status }
      }
    }
  }
}`;

const STATE_PARAMS: Record<PullRequestListState, string> = {
  all: "all",
  open: "opened",
  closed: "closed",
  merged: "merged",
};

const projectPath = (repository: string) => `projects/${encodeURIComponent(repository)}`;

const mergeRequestPath = (repository: string, number: number) =>
  `${projectPath(repository)}/merge_requests/${number}`;

const queryString = (params: ReadonlyArray<readonly [string, string]>) =>
  params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");

export function buildListPath(input: {
  readonly repository: string;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string;
}): string {
  const involvement: ReadonlyArray<readonly [string, string]> =
    input.involvement === "authored"
      ? [["author_username", input.viewer]]
      : input.involvement === "reviewing"
        ? [["reviewer_username", input.viewer]]
        : [];
  return `${projectPath(input.repository)}/merge_requests?${queryString([
    ["state", STATE_PARAMS[input.state]],
    ...involvement,
    ...(input.query ? ([["search", input.query]] as const) : []),
    // Without it labels are bare names, and the rows color them.
    ["with_labels_details", "true"],
    ["order_by", "updated_at"],
    ["sort", "desc"],
    ["per_page", String(ROWS_PER_PROJECT + 1)],
  ])}`;
}

function actorOf(value: unknown): PullRequestActor | null {
  if (!isRecord(value)) return null;
  const login = text(value.username);
  if (login === null) return null;
  return {
    login: login as PullRequestActor["login"],
    name: text(value.name),
    avatarUrl: text(value.avatar_url),
  };
}

function labelsOf(value: unknown): ReadonlyArray<PullRequestLabel> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label: unknown) => {
    const name = isRecord(label) ? text(label.name) : text(label);
    return name === null
      ? []
      : [
          {
            name: name as PullRequestLabel["name"],
            color: isRecord(label) ? text(label.color) : null,
          },
        ];
  });
}

function stateOf(raw: Record<string, unknown>): PullRequestState {
  if (raw.state === "merged" || text(raw.merged_at) !== null) return "merged";
  return raw.state === "closed" ? "closed" : "open";
}

const isDraftOf = (raw: Record<string, unknown>) =>
  raw.draft === true || raw.work_in_progress === true;

function mergeabilityOf(raw: Record<string, unknown>): PullRequestMergeability {
  const status = text(raw.detailed_merge_status) ?? text(raw.merge_status);
  if (raw.has_conflicts === true || status === "conflict" || status === "cannot_be_merged") {
    return "conflicting";
  }
  // While GitLab is still computing, `has_conflicts` is just false.
  if (status === null || status === "checking" || status === "unchecked") return "unknown";
  // Any other status is a gate like approvals or a pipeline, not a conflict.
  return raw.has_conflicts === false ? "mergeable" : "unknown";
}

function reviewDecisionOf(
  detailedStatus: unknown,
  fromApprovals?: PullRequestReviewDecision,
): PullRequestReviewDecision | undefined {
  if (detailedStatus === "requested_changes") return "changes-requested";
  if (detailedStatus === "not_approved") return "review-required";
  return fromApprovals;
}

export function parseListRow(
  raw: Record<string, unknown>,
  host: string,
  repository: string,
  viewer: string | null,
): PullRequestHostRow | null {
  const number = raw.iid;
  const title = text(raw.title);
  const url = text(raw.web_url);
  const headBranch = text(raw.source_branch);
  const baseBranch = text(raw.target_branch);
  const createdAt = text(raw.created_at);
  const updatedAt = text(raw.updated_at);
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
  const reviewers = Array.isArray(raw.reviewers) ? (raw.reviewers as ReadonlyArray<unknown>) : [];
  const reviewDecision = reviewDecisionOf(raw.detailed_merge_status);
  return {
    provider: "gitlab",
    host: host as PullRequestHostRow["host"],
    repository: repository as PullRequestHostRow["repository"],
    number: number as PullRequestHostRow["number"],
    title: title as PullRequestHostRow["title"],
    url: url as PullRequestHostRow["url"],
    author: actorOf(raw.author),
    headBranch: headBranch as PullRequestHostRow["headBranch"],
    baseBranch: baseBranch as PullRequestHostRow["baseBranch"],
    state: stateOf(raw),
    isDraft: isDraftOf(raw),
    mergeability: mergeabilityOf(raw),
    additions: 0 as PullRequestHostRow["additions"],
    deletions: 0 as PullRequestHostRow["deletions"],
    createdAt,
    updatedAt,
    viewerReviewRequested:
      viewer !== null &&
      reviewers.some((reviewer) => actorOf(reviewer)?.login.toLowerCase() === viewer.toLowerCase()),
    labels: labelsOf(raw.labels),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
  };
}

export interface GitLabRowFacts {
  readonly additions: number;
  readonly deletions: number;
  readonly checksState?: PullRequestChecksState;
  readonly reviewDecision?: PullRequestReviewDecision;
}

/**
 * Only Enterprise Edition holds `approved` to the project's approval rules, so an
 * unapproved merge request there still needs review even with no approvals yet.
 * Community Edition reports `approved` once anyone approves and requires no review.
 */
export function parseRowFacts(answer: unknown): ReadonlyMap<number, GitLabRowFacts> {
  const facts = new Map<number, GitLabRowFacts>();
  const data = isRecord(answer) ? answer.data : null;
  if (!isRecord(data)) return facts;
  const enterprise = isRecord(data.metadata) ? data.metadata.enterprise === true : false;
  const project = isRecord(data.project) ? data.project : null;
  const connection = isRecord(project?.mergeRequests) ? project.mergeRequests : null;
  const nodes = Array.isArray(connection?.nodes)
    ? (connection.nodes as ReadonlyArray<unknown>).filter(isRecord)
    : [];
  for (const node of nodes) {
    const number = Number(node.iid);
    if (!Number.isSafeInteger(number)) continue;
    const stats = isRecord(node.diffStatsSummary) ? node.diffStatsSummary : null;
    const approvedBy = isRecord(node.approvedBy) ? node.approvedBy.nodes : null;
    const approvals = Array.isArray(approvedBy) ? approvedBy.length : 0;
    const pipelineStatus = isRecord(node.headPipeline) ? text(node.headPipeline.status) : null;
    const checks = gitLabChecks(pipelineStatus?.toLowerCase());
    const reviewDecision: PullRequestReviewDecision | undefined =
      node.approved === false && (enterprise || approvals > 0)
        ? "review-required"
        : approvals > 0
          ? "approved"
          : undefined;
    facts.set(number, {
      additions: count(stats?.additions),
      deletions: count(stats?.deletions),
      ...(checks !== "none" ? { checksState: checks } : {}),
      ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    });
  }
  return facts;
}

function withFacts(row: PullRequestHostRow, facts: GitLabRowFacts | undefined): PullRequestHostRow {
  if (facts === undefined) return row;
  const reviewDecision = row.reviewDecision ?? facts.reviewDecision;
  return {
    ...row,
    additions: facts.additions as PullRequestHostRow["additions"],
    deletions: facts.deletions as PullRequestHostRow["deletions"],
    ...(facts.checksState !== undefined ? { checksState: facts.checksState } : {}),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
  };
}

function checkStatusOf(status: unknown, allowFailure: unknown): PullRequestCheckStatus {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      // The same reading as GitLab's: this failure doesn't fail the pipeline.
      return allowFailure === true ? "neutral" : "failure";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
      return allowFailure === false ? "action-required" : "neutral";
    default:
      return "pending";
  }
}

/** Jobs as checks; a job's own page is where its log is. */
export function parseJobs(raw: unknown): ReadonlyArray<PullRequestCheck> {
  if (!Array.isArray(raw)) return [];
  return (raw as ReadonlyArray<unknown>).filter(isRecord).flatMap((job) => {
    const name = text(job.name);
    if (name === null) return [];
    const stage = text(job.stage);
    return [
      {
        name: (stage !== null ? `${stage} / ${name}` : name) as PullRequestCheck["name"],
        status: checkStatusOf(job.status, job.allow_failure),
        description: text(job.failure_reason),
        url: text(job.web_url),
        required: job.allow_failure !== true,
      },
    ];
  });
}

/** What's left when the jobs can't be read, as on a fork's pipeline. */
function pipelineCheck(pipeline: unknown): ReadonlyArray<PullRequestCheck> {
  if (!isRecord(pipeline)) return [];
  return [
    {
      name: "Pipeline" as PullRequestCheck["name"],
      status: checkStatusOf(pipeline.status, undefined),
      description: text(pipeline.source),
      url: text(pipeline.web_url),
    },
  ];
}

/** System notes ("approved this", "added 1 commit") are GitLab's own timeline. */
export function parseNotes(
  raw: unknown,
  mergeRequestUrl: string | null,
): ReadonlyArray<PullRequestComment> {
  if (!Array.isArray(raw)) return [];
  return (raw as ReadonlyArray<unknown>).filter(isRecord).flatMap((note) => {
    const createdAt = text(note.created_at);
    const body = typeof note.body === "string" ? note.body : "";
    if (
      typeof note.id !== "number" ||
      createdAt === null ||
      note.system === true ||
      body.trim().length === 0
    ) {
      return [];
    }
    const position = isRecord(note.position) ? note.position : null;
    return [
      {
        id: String(note.id) as PullRequestComment["id"],
        kind: note.type === "DiffNote" ? ("review-comment" as const) : ("issue-comment" as const),
        author: actorOf(note.author),
        body,
        createdAt,
        url: mergeRequestUrl !== null ? `${mergeRequestUrl}#note_${note.id}` : null,
        path: text(position?.new_path) ?? text(position?.old_path),
        reviewState: null,
      },
    ];
  });
}

/** GitLab answers newest first; the page reads oldest first, as on GitHub. */
export function parseCommits(raw: unknown): ReadonlyArray<PullRequestCommit> {
  if (!Array.isArray(raw)) return [];
  return (raw as ReadonlyArray<unknown>)
    .filter(isRecord)
    .flatMap((commit) => {
      const oid = text(commit.id);
      const committedDate = text(commit.committed_date) ?? text(commit.created_at);
      if (oid === null || committedDate === null) return [];
      const login = text(commit.author_name) ?? text(commit.author_email);
      return [
        {
          oid: oid as PullRequestCommit["oid"],
          messageHeadline: typeof commit.title === "string" ? commit.title : "",
          committedDate,
          authors:
            login === null
              ? []
              : [
                  {
                    login: login as PullRequestActor["login"],
                    name: text(commit.author_name),
                    avatarUrl: null,
                  },
                ],
          url: text(commit.web_url),
        },
      ];
    })
    .toReversed();
}

/**
 * `merge` and `rebase` are the project's one setting, not a choice per merge
 * request. `always` squashes whatever is picked, so nothing else is honest to show.
 */
export function parseMergeMethods(project: unknown): ReadonlyArray<PullRequestMergeMethod> {
  const all = GITLAB_PULL_REQUEST_CAPABILITIES.mergeMethods;
  if (!isRecord(project)) return all;
  const method = text(project.merge_method);
  const squash = text(project.squash_option);
  // Hidden from people without access to the code: the merge itself decides.
  if (method === null) return all;
  if (squash === "always") return ["squash"];
  const squashable = squash === "default_on" || squash === "default_off";
  return [
    ...(method === "merge" ? (["merge"] as const) : []),
    ...(squashable ? (["squash"] as const) : []),
    ...(method === "rebase_merge" || method === "ff" ? (["rebase"] as const) : []),
  ];
}

export function parseDetail(
  raw: Record<string, unknown>,
  context: {
    readonly host: string;
    readonly repository: string;
    readonly viewer: string | null;
    readonly facts?: GitLabRowFacts | undefined;
    readonly comments: ReadonlyArray<PullRequestComment>;
    readonly commits: ReadonlyArray<PullRequestCommit>;
    readonly checks: ReadonlyArray<PullRequestCheck>;
    readonly mergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  },
): PullRequestHostDetail | null {
  const row = parseListRow(raw, context.host, context.repository, context.viewer);
  if (row === null) return null;
  const reviewDecision = reviewDecisionOf(raw.detailed_merge_status, context.facts?.reviewDecision);
  const autoMerge =
    raw.merge_when_pipeline_succeeds == null && raw.auto_merge_enabled == null
      ? undefined
      : raw.merge_when_pipeline_succeeds === true || raw.auto_merge_enabled === true;
  return {
    provider: "gitlab",
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
    additions: count(context.facts?.additions) as PullRequestHostDetail["additions"],
    deletions: count(context.facts?.deletions) as PullRequestHostDetail["deletions"],
    // "1000+" past GitLab's counting limit.
    changedFiles: (Number.parseInt(String(raw.changes_count), 10) ||
      0) as PullRequestHostDetail["changedFiles"],
    headBranch: row.headBranch,
    headSha: text(raw.sha) as PullRequestHostDetail["headSha"],
    baseBranch: row.baseBranch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mergedAt: text(raw.merged_at),
    closedAt: text(raw.closed_at),
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    labels: row.labels,
    checks: context.checks,
    ...(autoMerge !== undefined ? { autoMergeEnabled: autoMerge } : {}),
    ...(context.viewer !== null
      ? { viewer: context.viewer as NonNullable<PullRequestHostDetail["viewer"]> }
      : {}),
    comments: context.comments.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    commits: context.commits,
    mergeMethods: context.mergeMethods,
  };
}

const QUOTED_CHARACTERS = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\r", "\\r"],
]);

/** As Git writes a path into a patch header: quoted only when it has to be. */
function patchPath(path: string): string {
  let body = "";
  let quoted = false;
  for (const character of path) {
    const escape = QUOTED_CHARACTERS.get(character);
    quoted = quoted || escape !== undefined;
    body += escape ?? character;
  }
  return quoted ? `"${body}"` : path;
}

function lineCounts(hunks: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunks.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** GitLab sends each file's hunks alone; the page wants the patch Git would print. */
export function parseDiffPage(entries: unknown): {
  readonly patch: string;
  readonly files: ReadonlyArray<PullRequestDiffFile>;
  /** A file GitLab held back: partly shown would read as "nothing changed there". */
  readonly incomplete: boolean;
  readonly rawCount: number;
} {
  const raw = Array.isArray(entries) ? (entries as ReadonlyArray<unknown>) : [];
  const files: PullRequestDiffFile[] = [];
  const sections: string[] = [];
  let incomplete = false;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const oldPath = text(entry.old_path);
    const newPath = text(entry.new_path);
    if (oldPath === null || newPath === null) {
      incomplete = true;
      continue;
    }
    const hunks = typeof entry.diff === "string" ? entry.diff : "";
    if (hunks.length === 0 && (entry.too_large === true || entry.collapsed === true)) {
      incomplete = true;
    }
    const isNew = entry.new_file === true;
    const isDeleted = entry.deleted_file === true;
    const header = [
      `diff --git ${patchPath(`a/${oldPath}`)} ${patchPath(`b/${newPath}`)}`,
      ...(isNew ? [`new file mode ${text(entry.b_mode) ?? "100644"}`] : []),
      ...(isDeleted ? [`deleted file mode ${text(entry.a_mode) ?? "100644"}`] : []),
      ...(entry.renamed_file === true
        ? [`rename from ${patchPath(oldPath)}`, `rename to ${patchPath(newPath)}`]
        : []),
      `--- ${isNew ? "/dev/null" : patchPath(`a/${oldPath}`)}`,
      `+++ ${isDeleted ? "/dev/null" : patchPath(`b/${newPath}`)}`,
    ].join("\n");
    sections.push(
      hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.replace(/\n?$/u, "\n")}`,
    );
    const lines = lineCounts(hunks);
    files.push({
      path: newPath as PullRequestDiffFile["path"],
      additions: lines.additions as PullRequestDiffFile["additions"],
      deletions: lines.deletions as PullRequestDiffFile["deletions"],
      viewed: "unviewed",
    });
  }
  return { patch: sections.join(""), files, incomplete, rawCount: raw.length };
}

/** Left out unless a method was picked, so the project's own default applies. */
export function buildMergeBody(input: PullRequestHostActionInput): Record<string, boolean> {
  return {
    ...(input.mergeMethod !== undefined ? { squash: input.mergeMethod === "squash" } : {}),
    // Sent when false too: otherwise the merge request's own setting would delete the branch.
    ...(input.deleteBranch !== undefined
      ? { should_remove_source_branch: input.deleteBranch }
      : {}),
    // Not `auto_merge`: only GitLab 17.11 and later know that name, and both still take this one.
    ...(input.action === "enable-auto-merge" ? { merge_when_pipeline_succeeds: true } : {}),
  };
}

export function makeGitLabPullRequestHost(
  gitlab: Pick<GitLabCliShape, "execute">,
  hostname: string,
): PullRequestHostShape {
  const failure = (operation: string, detail: string) =>
    new SourceControlProviderError({ provider: "gitlab", operation, detail });

  const providerError = (operation: string) => (cause: GitLabCliError) =>
    new SourceControlProviderError({
      provider: "gitlab",
      operation,
      detail: cause.detail,
      cause,
    });

  const api = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly path: string;
    readonly method?: "POST" | "PUT";
    readonly body?: unknown;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) =>
    gitlab
      .execute({
        cwd: input.cwd,
        host: hostname,
        args: [
          "api",
          input.path,
          ...(input.method !== undefined ? ["--method", input.method] : []),
          // `--input` sends a body but leaves out the Content-Type GitLab requires.
          ...(input.body !== undefined
            ? ["--input", "-", "--header", "Content-Type: application/json"]
            : []),
        ],
        ...(input.body !== undefined ? { stdin: JSON.stringify(input.body) } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined
          ? { maxOutputBytes: input.maxOutputBytes, truncateOutputAtMaxBytes: true }
          : {}),
      })
      .pipe(Effect.mapError(providerError(input.operation)));

  const parseAnswer = (stdout: string, operation: string) =>
    Effect.try({
      try: () => JSON.parse(stdout) as unknown,
      catch: () => failure(operation, "GitLab answered with something that isn't JSON."),
    });

  const readJson = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly path: string;
  }) => api(input).pipe(Effect.flatMap((result) => parseAnswer(result.stdout, input.operation)));

  const viewerOf = (cwd: string, operation: string) =>
    readJson({ cwd, operation, path: "user" }).pipe(
      Effect.flatMap((user) => {
        const login = isRecord(user) ? text(user.username) : null;
        return login !== null
          ? Effect.succeed(login)
          : Effect.fail(failure(operation, "GitLab didn't say who is signed in."));
      }),
    );

  /** Line counts and such: rows and pages stand without them, so a miss costs only those. */
  const rowFacts = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) =>
    input.numbers.length === 0
      ? Effect.succeed<ReadonlyMap<number, GitLabRowFacts>>(new Map())
      : api({
          cwd: input.cwd,
          operation: "readMergeRequestFacts",
          path: "graphql",
          method: "POST",
          body: {
            query: ROW_FACTS_QUERY,
            variables: { fullPath: input.repository, iids: input.numbers.map(String) },
          },
        }).pipe(
          Effect.flatMap((result) => parseAnswer(result.stdout, "readMergeRequestFacts")),
          Effect.map(parseRowFacts),
          Effect.catch(() =>
            Effect.logWarning("gitlab: merge request facts skipped").pipe(
              Effect.annotateLogs({ repository: input.repository }),
              Effect.as<ReadonlyMap<number, GitLabRowFacts>>(new Map()),
            ),
          ),
        );

  const listProject = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly query?: string;
  }) =>
    Effect.gen(function* () {
      const answer = yield* readJson({
        cwd: input.cwd,
        operation: "listPullRequests",
        path: buildListPath(input),
      });
      const raw = Array.isArray(answer) ? (answer as ReadonlyArray<unknown>).filter(isRecord) : [];
      const rows = raw.slice(0, ROWS_PER_PROJECT).flatMap((entry) => {
        const row = parseListRow(entry, hostname, input.repository, input.viewer);
        return row === null ? [] : [row];
      });
      const facts = yield* rowFacts({
        cwd: input.cwd,
        repository: input.repository,
        numbers: rows.map((row) => row.number),
      });
      return {
        rows: rows.map((row) => withFacts(row, facts.get(row.number))),
        truncated: raw.length > ROWS_PER_PROJECT,
      };
    });

  const notesOf = (input: PullRequestHostTarget, mergeRequestUrl: string | null) =>
    Effect.gen(function* () {
      const comments: PullRequestComment[] = [];
      // Newest first: past the last page it's the old talk that goes missing.
      for (let page = 1; page <= MAX_NOTE_PAGES; page += 1) {
        const answer = yield* readJson({
          cwd: input.cwd,
          operation: "listMergeRequestNotes",
          path: `${mergeRequestPath(input.repository, input.number)}/notes?${queryString([
            ["order_by", "created_at"],
            ["sort", "desc"],
            ["per_page", String(PAGE_SIZE)],
            ["page", String(page)],
          ])}`,
        });
        comments.push(...parseNotes(answer, mergeRequestUrl));
        if (!Array.isArray(answer) || answer.length < PAGE_SIZE) break;
      }
      return comments;
    });

  const checksOf = (cwd: string, repository: string, pipeline: unknown) => {
    const fallback = pipelineCheck(pipeline);
    if (!isRecord(pipeline) || typeof pipeline.id !== "number") {
      return Effect.succeed(fallback);
    }
    // On a fork the pipeline can belong to the source project, not this one.
    const project =
      typeof pipeline.project_id === "number"
        ? `projects/${pipeline.project_id}`
        : projectPath(repository);
    return readJson({
      cwd,
      operation: "listPipelineJobs",
      path: `${project}/pipelines/${pipeline.id}/jobs?per_page=${PAGE_SIZE}`,
    }).pipe(
      Effect.map((answer) => {
        const jobs = parseJobs(answer);
        return jobs.length > 0 ? jobs : fallback;
      }),
      Effect.orElseSucceed(() => fallback),
    );
  };

  return {
    label: "GitLab",
    capabilities: GITLAB_PULL_REQUEST_CAPABILITIES,

    list: (input) =>
      Effect.gen(function* () {
        const viewer = yield* viewerOf(input.cwd, "listPullRequests");
        const repositories = input.repositories.slice(0, MAX_PROJECTS);
        const answers = yield* Effect.forEach(
          repositories,
          (repository) =>
            listProject({
              cwd: input.cwd,
              repository,
              state: input.state,
              involvement: input.involvement,
              viewer,
              ...(input.query !== undefined ? { query: input.query } : {}),
            }),
          { concurrency: REQUEST_CONCURRENCY },
        );
        return {
          viewer,
          rows: answers.flatMap((answer) => answer.rows),
          truncated:
            input.repositories.length > MAX_PROJECTS || answers.some((answer) => answer.truncated),
        };
      }),

    detail: (input) =>
      Effect.gen(function* () {
        const operation = "getPullRequestDetail";
        const [viewer, answer] = yield* Effect.all(
          [
            viewerOf(input.cwd, operation),
            readJson({
              cwd: input.cwd,
              operation,
              path: mergeRequestPath(input.repository, input.number),
            }),
          ],
          { concurrency: 2 },
        );
        if (!isRecord(answer)) return yield* failure(operation, "Merge request not found.");
        const [comments, commits, facts, checks, mergeMethods] = yield* Effect.all(
          [
            notesOf(input, text(answer.web_url)),
            readJson({
              cwd: input.cwd,
              operation,
              path: `${mergeRequestPath(input.repository, input.number)}/commits?per_page=${PAGE_SIZE}`,
            }).pipe(Effect.map(parseCommits)),
            rowFacts({ cwd: input.cwd, repository: input.repository, numbers: [input.number] }),
            checksOf(input.cwd, input.repository, answer.head_pipeline),
            readJson({
              cwd: input.cwd,
              operation,
              path: `${projectPath(input.repository)}?license=false`,
            }).pipe(
              Effect.map(parseMergeMethods),
              Effect.orElseSucceed(() => GITLAB_PULL_REQUEST_CAPABILITIES.mergeMethods),
            ),
          ],
          { concurrency: REQUEST_CONCURRENCY },
        );
        const detail = parseDetail(answer, {
          host: hostname,
          repository: input.repository,
          viewer,
          facts: facts.get(input.number),
          comments,
          commits,
          checks,
          mergeMethods,
        });
        return detail !== null ? detail : yield* failure(operation, "Merge request not found.");
      }),

    diff: (input) =>
      Effect.gen(function* () {
        const operation = "getPullRequestDiff";
        const pageSize =
          input.commit === undefined ? MERGE_REQUEST_DIFF_PAGE_SIZE : COMMIT_DIFF_PAGE_SIZE;
        const base =
          input.commit === undefined
            ? `${mergeRequestPath(input.repository, input.number)}/diffs`
            : `${projectPath(input.repository)}/repository/commits/${encodeURIComponent(input.commit)}/diff`;
        const files: PullRequestDiffFile[] = [];
        let patch = "";
        let truncated = false;
        for (let page = 1; ; page += 1) {
          const result = yield* api({
            cwd: input.cwd,
            operation,
            path: `${base}?${queryString([
              ["per_page", String(pageSize)],
              ["page", String(page)],
            ])}`,
            maxOutputBytes: MAX_DIFF_BYTES,
            timeoutMs: DIFF_TIMEOUT_MS,
          });
          if (result.stdoutTruncated) {
            truncated = true;
            patch = "";
            break;
          }
          const parsed = parseDiffPage(yield* parseAnswer(result.stdout, operation));
          files.push(...parsed.files);
          truncated =
            truncated || parsed.incomplete || patch.length + parsed.patch.length > MAX_DIFF_BYTES;
          patch = truncated ? "" : patch + parsed.patch;
          if (parsed.rawCount < pageSize) break;
          if (page === MAX_DIFF_PAGES) {
            truncated = true;
            patch = "";
            break;
          }
        }
        return { diff: patch, files, truncated };
      }),

    runAction: (input) =>
      Effect.gen(function* () {
        const operation = `pullRequest.${input.action}`;
        const mergeRequest = mergeRequestPath(input.repository, input.number);
        const target = [String(input.number), "--repo", input.repository];
        const write = (path: string, method: "POST" | "PUT", body?: unknown) =>
          api({
            cwd: input.cwd,
            operation,
            path,
            method,
            ...(body !== undefined ? { body } : {}),
          });
        switch (input.action) {
          case "merge":
          case "enable-auto-merge":
            if (input.mergeMethod === "rebase") {
              yield* gitlab
                .execute({
                  cwd: input.cwd,
                  host: hostname,
                  args: ["mr", "rebase", ...target],
                  timeoutMs: REBASE_TIMEOUT_MS,
                })
                .pipe(Effect.mapError(providerError(operation)));
            }
            yield* write(`${mergeRequest}/merge`, "PUT", buildMergeBody(input));
            return { url: null };
          case "disable-auto-merge":
            yield* write(`${mergeRequest}/cancel_merge_when_pipeline_succeeds`, "POST");
            return { url: null };
          case "approve":
            yield* write(`${mergeRequest}/approve`, "POST");
            return { url: null };
          case "ready":
            // The API has no draft flag, only the title's prefix; `glab` knows every spelling.
            yield* gitlab
              .execute({
                cwd: input.cwd,
                host: hostname,
                args: ["mr", "update", ...target, "--ready"],
              })
              .pipe(Effect.mapError(providerError(operation)));
            return { url: null };
          case "close":
            yield* write(mergeRequest, "PUT", { state_event: "close" });
            return { url: null };
          case "reopen":
            yield* write(mergeRequest, "PUT", { state_event: "reopen" });
            return { url: null };
          case "revert":
            return yield* failure(operation, "GitLab has no revert command.");
        }
      }),

    comment: (input) =>
      api({
        cwd: input.cwd,
        operation: "commentOnPullRequest",
        path: `${mergeRequestPath(input.repository, input.number)}/notes`,
        method: "POST",
        body: { body: input.body },
      }).pipe(Effect.asVoid),
  };
}
