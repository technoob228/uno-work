/**
 * What Dev mode's pull request page asks of a host. One implementation per
 * service, on top of the CLI or API that service's provider already uses, so
 * sign-in stays where it is: `gh`, `glab`, `az`, the saved Bitbucket token.
 *
 * A host says what it can in `capabilities`; the page shows only that. Anything
 * optional here is a thing some host doesn't have.
 *
 * @module sourceControl/pullRequestHost
 */
import type {
  PullRequestAction,
  PullRequestCapabilities,
  PullRequestDetailView,
  PullRequestDiffResult,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListState,
  PullRequestMergeMethod,
  SourceControlProviderError,
} from "@t3tools/contracts";
import type { Effect } from "effect";

/** A row before it is tied to a project of this computer. */
export type PullRequestHostRow = Omit<PullRequestListEntry, "projectId" | "projectTitle">;

export type PullRequestHostDetail = Omit<
  PullRequestDetailView,
  "projectId" | "projectTitle" | "capabilities"
>;

export interface PullRequestHostTarget {
  readonly cwd: string;
  /** `owner/name`, or `group/sub/name` on GitLab. */
  readonly repository: string;
  readonly number: number;
}

export interface PullRequestHostListInput {
  readonly cwd: string;
  readonly repositories: ReadonlyArray<string>;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly query?: string;
}

export interface PullRequestHostList {
  readonly viewer: string | null;
  readonly rows: ReadonlyArray<PullRequestHostRow>;
  readonly truncated: boolean;
}

export interface PullRequestHostActionInput extends PullRequestHostTarget {
  readonly action: PullRequestAction;
  readonly mergeMethod?: PullRequestMergeMethod;
  readonly deleteBranch?: boolean;
  readonly removeAgentCredits?: boolean;
}

export interface PullRequestHostShape {
  readonly label: string;
  readonly capabilities: PullRequestCapabilities;
  readonly list: (
    input: PullRequestHostListInput,
  ) => Effect.Effect<PullRequestHostList, SourceControlProviderError>;
  readonly detail: (
    input: PullRequestHostTarget,
  ) => Effect.Effect<PullRequestHostDetail, SourceControlProviderError>;
  readonly diff?: (
    input: PullRequestHostTarget & { readonly commit?: string },
  ) => Effect.Effect<PullRequestDiffResult, SourceControlProviderError>;
  readonly runAction: (
    input: PullRequestHostActionInput,
  ) => Effect.Effect<{ readonly url: string | null }, SourceControlProviderError>;
  readonly setFileViewed?: (
    input: PullRequestHostTarget & { readonly path: string; readonly viewed: boolean },
  ) => Effect.Effect<void, SourceControlProviderError>;
  readonly comment?: (
    input: PullRequestHostTarget & { readonly body: string },
  ) => Effect.Effect<void, SourceControlProviderError>;
}

/**
 * Host search and CLI arguments take these from a client: a name that could read
 * as a flag or a path stops here. `owner/name`, GitLab groups, Azure `org/project/repo`.
 */
export function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._ -]*){1,6}$/u.test(value);
}

export const isCommitSha = (value: string): boolean => /^[0-9a-f]{7,64}$/iu.test(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A non-empty string, or null: what a host's optional fields come down to. */
export const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const count = (value: unknown): number =>
  typeof value === "number" && value >= 0 ? value : 0;
