/**
 * Dev mode's pull requests: the list, one pull request, and what can be done to
 * it from inside Work. The names and shapes follow upstream's
 * `contracts/pullRequest.ts`, cut down to what we show. Pull requests live on
 * the host (GitHub, GitLab…); these are reads and actions through the service
 * the person connected, nothing is kept here.
 *
 * @module pullRequest
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

export const PullRequestChecksState = Schema.Literals(["passing", "failing", "pending"]);
export type PullRequestChecksState = typeof PullRequestChecksState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals([
  "merge",
  "enable-auto-merge",
  "disable-auto-merge",
  "approve",
  "ready",
  "close",
  "reopen",
  "revert",
]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestActor = Schema.Struct({
  isBot: Schema.optional(Schema.Boolean),
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "action-required",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
});
export type PullRequestComment = typeof PullRequestComment.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
  authors: Schema.optional(Schema.Array(PullRequestActor)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

/** What this host can do at all. A button shows only when its action is here. */
export const PullRequestCapabilities = Schema.Struct({
  actions: Schema.Array(PullRequestAction),
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  /** Reads the changes inside Work; otherwise the row links to the host's site. */
  diff: Schema.Boolean,
  comment: Schema.Boolean,
  /** Viewed marks live on the host, and show on its site too. */
  viewedFiles: Schema.Boolean,
  /** An agent's credit lines can come out of the merge commit. */
  mergeMessageRewrite: Schema.Boolean,
  /** Merge can delete the source branch. */
  deleteBranch: Schema.Boolean,
  /**
   * Every head gets at least one check, so a head that has gone a while without any
   * means none reported. Absent: an empty list says nothing.
   */
  checksAlwaysReport: Schema.optional(Schema.Boolean),
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

export const PullRequestListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  viewerReviewRequested: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  checksState: Schema.optional(PullRequestChecksState),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  involvement: Schema.optional(PullRequestInvolvement),
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

export const PullRequestProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  label: TrimmedNonEmptyString,
  projectCount: PositiveInt,
  /** Reads work. False: `detail` says what to do, in a line for the person. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: PullRequestCapabilities,
});
export type PullRequestProviderSummary = typeof PullRequestProviderSummary.Type;

export const PullRequestListResult = Schema.Struct({
  /** The signed-in login per host. Unreadable hosts are absent. */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(PullRequestProviderSummary),
  entries: Schema.Array(PullRequestListEntry),
  truncated: Schema.Boolean,
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

export const PullRequestDetailView = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  capabilities: PullRequestCapabilities,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  /** Absent: the host doesn't say. */
  autoMergeEnabled: Schema.optional(Schema.Boolean),
  viewer: Schema.optional(TrimmedNonEmptyString),
  comments: Schema.Array(PullRequestComment),
  commits: Schema.Array(PullRequestCommit),
  /** Merge methods the repository allows here; narrows `capabilities.mergeMethods`. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
});
export type PullRequestDetailView = typeof PullRequestDetailView.Type;

export const PullRequestDiffInput = Schema.Struct({
  ...PullRequestRef.fields,
  /** One commit of the pull request; absent: all of it. */
  commit: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type PullRequestDiffInput = typeof PullRequestDiffInput.Type;

export const PullRequestFileViewedState = Schema.Literals(["viewed", "unviewed", "changed"]);
export type PullRequestFileViewedState = typeof PullRequestFileViewedState.Type;

export const PullRequestDiffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  viewed: PullRequestFileViewedState,
});
export type PullRequestDiffFile = typeof PullRequestDiffFile.Type;

export const PullRequestDiffResult = Schema.Struct({
  /** A unified diff. Empty with `truncated`: too large to read here. */
  diff: Schema.String,
  files: Schema.Array(PullRequestDiffFile),
  truncated: Schema.Boolean,
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestActionInput = Schema.Struct({
  ...PullRequestRef.fields,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  deleteBranch: Schema.optional(Schema.Boolean),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

export const PullRequestActionResult = Schema.Struct({
  /** What the action made, such as the revert's pull request. */
  url: Schema.NullOr(Schema.String),
});
export type PullRequestActionResult = typeof PullRequestActionResult.Type;

export const PullRequestSetFileViewedInput = Schema.Struct({
  ...PullRequestRef.fields,
  path: TrimmedNonEmptyString,
  viewed: Schema.Boolean,
});
export type PullRequestSetFileViewedInput = typeof PullRequestSetFileViewedInput.Type;

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)),
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

/** Starts or stops the agent watching a pull request of its chat. */
export const PullRequestWatchInput = Schema.Struct({
  threadId: ThreadId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  watching: Schema.Boolean,
});
export type PullRequestWatchInput = typeof PullRequestWatchInput.Type;

/** Keeps a pull request with a chat, by its link or `owner/name#12`. */
export const PullRequestLinkInput = Schema.Struct({
  threadId: ThreadId,
  reference: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type PullRequestLinkInput = typeof PullRequestLinkInput.Type;

export const PullRequestUnlinkInput = Schema.Struct({
  threadId: ThreadId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestUnlinkInput = typeof PullRequestUnlinkInput.Type;

export const PullRequestErrorReason = Schema.Literals([
  "dev-mode-off",
  "not-connected",
  "unsupported",
  "not-found",
  "host",
]);
export type PullRequestErrorReason = typeof PullRequestErrorReason.Type;

export class PullRequestError extends Schema.TaggedErrorClass<PullRequestError>()(
  "PullRequestError",
  {
    reason: PullRequestErrorReason,
    /** A line for the person; never a token or a command line. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
