/**
 * Many pull requests and branches of one repository in one GraphQL request.
 *
 * `gh pr view` and `gh pr list` cost a request each. A thread list polled every
 * minute would burn the person's 5000 points an hour, so the whole sweep of a
 * repository goes as one document: aliases for numbers, aliases for branches.
 * That costs one point (`first: 3` keeps it there, see BRANCH_MATCHES), and
 * `rateLimit` in the same document tells how much is left, for free.
 */
import type {
  ChangeRequestChecksState,
  ChangeRequestReviewState,
  ChangeRequestStatus,
} from "@t3tools/contracts";

import type { ChangeRequestStatusRead } from "./SourceControlProvider.ts";

/** The most a document asks for; more waits for the next one. */
export const MAX_STATUS_READS_PER_DOCUMENT = 25;
/** Enough to see past an older merged PR on a reused branch. */
const BRANCH_MATCHES = 3;

const PULL_REQUEST_FIELDS = `fragment Status on PullRequest {
  number title url state isDraft headRefName baseRefName isCrossRepository
  updatedAt mergedAt closedAt reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export interface GitHubStatusQuery {
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
}

export function buildStatusQuery(input: {
  readonly repository: string;
  readonly numbers: ReadonlyArray<number>;
  readonly branches: ReadonlyArray<string>;
}): GitHubStatusQuery {
  const [owner = "", name = ""] = input.repository.split("/");
  const variables: Record<string, string> = { owner, name };
  const branchVariables: string[] = [];
  const selections: string[] = [];
  for (const number of input.numbers) {
    selections.push(`pr${number}: pullRequest(number: ${number}) { ...Status }`);
  }
  input.branches.forEach((branch, index) => {
    // Branch names travel as variables: they come from the repository, not from us.
    variables[`branch${index}`] = branch;
    branchVariables.push(`$branch${index}: String!`);
    selections.push(
      `branch${index}: pullRequests(headRefName: $branch${index}, first: ${BRANCH_MATCHES}, ` +
        `states: [OPEN, MERGED, CLOSED], orderBy: { field: UPDATED_AT, direction: DESC }) ` +
        `{ nodes { ...Status } }`,
    );
  });
  const declared = ["$owner: String!", "$name: String!", ...branchVariables].join(", ");
  return {
    query: `query(${declared}) {
  rateLimit { cost remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    ${selections.join("\n    ")}
  }
}
${PULL_REQUEST_FIELDS}`,
    variables,
  };
}

interface RawPullRequest {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly state?: unknown;
  readonly isDraft?: unknown;
  readonly headRefName?: unknown;
  readonly baseRefName?: unknown;
  readonly isCrossRepository?: unknown;
  readonly updatedAt?: unknown;
  readonly mergedAt?: unknown;
  readonly closedAt?: unknown;
  readonly reviewDecision?: unknown;
  readonly commits?: {
    readonly nodes?: ReadonlyArray<{
      readonly commit?: { readonly statusCheckRollup?: { readonly state?: unknown } | null };
    }>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function checksOf(raw: RawPullRequest): ChangeRequestChecksState {
  const state = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

function reviewOf(raw: RawPullRequest): ChangeRequestReviewState {
  switch (raw.reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "none";
  }
}

function statusOf(raw: RawPullRequest): ChangeRequestStatus | null {
  const title = text(raw.title);
  const url = text(raw.url);
  const headRefName = text(raw.headRefName);
  const baseRefName = text(raw.baseRefName);
  if (
    typeof raw.number !== "number" ||
    title === null ||
    url === null ||
    headRefName === null ||
    baseRefName === null
  ) {
    return null;
  }
  return {
    number: raw.number as ChangeRequestStatus["number"],
    title: title as ChangeRequestStatus["title"],
    url,
    state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
    isDraft: raw.isDraft === true,
    headRefName: headRefName as ChangeRequestStatus["headRefName"],
    baseRefName: baseRefName as ChangeRequestStatus["baseRefName"],
    isCrossRepository: raw.isCrossRepository === true,
    updatedAt: text(raw.updatedAt),
    mergedAt: text(raw.mergedAt),
    closedAt: text(raw.closedAt),
    checks: checksOf(raw),
    review: reviewOf(raw),
  };
}

export type StatusResponse =
  | { readonly ok: true; readonly read: ChangeRequestStatusRead }
  | { readonly ok: false; readonly detail: string };

/**
 * A number GitHub can't find comes back as `null` with an `errors` entry and a
 * non-zero exit of `gh`, while everything else in the document is good: what
 * decides is whether `data` is there.
 */
export function parseStatusResponse(raw: string, branches: ReadonlyArray<string>): StatusResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "GitHub answered with something that isn't JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, detail: "GitHub sent an empty answer." };
  const data = parsed.data;
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const firstError = errors
    .map((error) => (isRecord(error) ? text(error.message) : null))
    .find((message) => message !== null);
  if (!isRecord(data)) {
    return { ok: false, detail: firstError ?? "GitHub sent no data." };
  }
  const repository = data.repository;
  if (!isRecord(repository)) {
    return { ok: false, detail: firstError ?? "GitHub doesn't show this repository." };
  }

  const byNumber = new Map<number, ChangeRequestStatus>();
  const byBranch = new Map<string, ReadonlyArray<ChangeRequestStatus>>();
  for (const [alias, value] of Object.entries(repository)) {
    if (alias.startsWith("pr") && isRecord(value)) {
      const status = statusOf(value as RawPullRequest);
      if (status !== null) byNumber.set(status.number, status);
    } else if (alias.startsWith("branch") && isRecord(value) && Array.isArray(value.nodes)) {
      const branch = branches[Number(alias.slice("branch".length))];
      if (branch === undefined) continue;
      byBranch.set(
        branch,
        value.nodes.flatMap((node) => {
          const status = isRecord(node) ? statusOf(node as RawPullRequest) : null;
          return status === null ? [] : [status];
        }),
      );
    }
  }
  const rateLimit = isRecord(data.rateLimit) ? data.rateLimit : null;
  const remaining = rateLimit?.remaining;
  const limit = rateLimit?.limit;
  return {
    ok: true,
    read: {
      byNumber,
      byBranch,
      budget:
        typeof remaining === "number" && typeof limit === "number"
          ? {
              remaining,
              limit,
              cost: typeof rateLimit?.cost === "number" ? rateLimit.cost : 1,
              resetAt: text(rateLimit?.resetAt),
            }
          : null,
    },
  };
}
