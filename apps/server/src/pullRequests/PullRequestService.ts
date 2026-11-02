/**
 * Dev mode's pull requests: the list across this computer's projects, one pull
 * request, and the actions on it. Everything goes to the host through the
 * provider of the project's remote (`pullRequestHost`), so a pull request is
 * never stored here and no new credential exists.
 *
 * Every entry point checks Dev mode on the server too: without it this service
 * spends none of the person's host limits, whatever a client asks.
 *
 * @module pullRequests/PullRequestService
 */
import {
  PullRequestError,
  type PullRequestActionInput,
  type PullRequestActionResult,
  type PullRequestCommentInput,
  type PullRequestDetailView,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestProviderSummary,
  type PullRequestRef,
  type PullRequestSetFileViewedInput,
  type SourceControlProviderError,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseRemoteRepositoryPath } from "@t3tools/shared/sourceControl";
import { Context, Effect, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { redactSecretsInText } from "../secretRedaction.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  isCommitSha,
  isRepositoryName,
  type PullRequestHostShape,
} from "../sourceControl/pullRequestHost.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { ThreadPullRequests } from "../threadPullRequests/ThreadPullRequestService.ts";

/** A remote rarely changes; `git remote` per project per list adds up. */
const PROJECT_REMOTE_TTL_MS = 5 * 60_000;
const PROJECT_CONCURRENCY = 4;
const ERROR_LINE_MAX = 300;

const PROVIDER_LABELS: Record<SourceControlProviderKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  "azure-devops": "Azure DevOps",
  unknown: "This service",
};

export interface ProjectRemote {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly cwd: string;
  readonly kind: SourceControlProviderKind;
  readonly hostname: string;
  readonly repository: string;
  /** Absent: Work has no pull requests for this service. */
  readonly host: PullRequestHostShape | null;
}

/**
 * The CLI's words for the person: the last line that isn't a label of ours,
 * without `gh`'s plumbing, with anything that looks like a secret masked.
 */
export function hostErrorLine(detail: string): string {
  const lines = redactSecretsInText(detail)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[A-Z][A-Za-z]+Error$/u.test(line));
  const line = (lines.at(-1) ?? "The service refused.")
    .replace(/^(?:Error: )?(?:gh: )?/u, "")
    .replace(/^failed to [^:]+: /u, "")
    .replace(/^GraphQL: /u, "")
    .replace(/ \([A-Za-z.]+\)$/u, "");
  return line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX - 1)}…` : line;
}

/** Reads a provider's failure: no tool, not signed in, gone, or the host's own reason. */
export function toPullRequestError(
  label: string,
  error: Pick<SourceControlProviderError, "detail">,
): PullRequestError {
  const { detail } = error;
  if (/not available on path|required but not|command not found|enoent/iu.test(detail)) {
    return new PullRequestError({
      reason: "not-connected",
      detail: `${label} needs its command-line tool on this computer. See Settings → Source control.`,
    });
  }
  if (/not authenticated|auth login|not logged in|no oauth token/iu.test(detail)) {
    return new PullRequestError({
      reason: "not-connected",
      detail: `${label} isn't signed in on this computer. See Settings → Source control.`,
    });
  }
  if (/not found|could not resolve/iu.test(detail)) {
    return new PullRequestError({ reason: "not-found", detail: `${label}: nothing found there.` });
  }
  return new PullRequestError({ reason: "host", detail: hostErrorLine(detail) });
}

export interface PullRequestsShape {
  readonly list: (
    input: PullRequestListInput,
  ) => Effect.Effect<PullRequestListResult, PullRequestError>;
  readonly detail: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestDetailView, PullRequestError>;
  readonly diff: (
    input: PullRequestDiffInput,
  ) => Effect.Effect<PullRequestDiffResult, PullRequestError>;
  readonly runAction: (
    input: PullRequestActionInput,
  ) => Effect.Effect<PullRequestActionResult, PullRequestError>;
  readonly setFileViewed: (
    input: PullRequestSetFileViewedInput,
  ) => Effect.Effect<void, PullRequestError>;
  readonly comment: (input: PullRequestCommentInput) => Effect.Effect<void, PullRequestError>;
}

export class PullRequests extends Context.Service<PullRequests, PullRequestsShape>()(
  "t3/pullRequests/PullRequestService",
) {}

export const makePullRequests = (options: { readonly now?: () => number } = {}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const sourceControl = yield* SourceControlProviderRegistry;
    const threads = yield* ThreadPullRequests;
    const nowMs = options.now ?? Date.now;

    const remotes = new Map<
      string,
      { readonly atMs: number; readonly remote: ProjectRemote | null }
    >();

    const requireDevMode = settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ devMode: false })),
      Effect.flatMap((current) =>
        current.devMode
          ? Effect.void
          : Effect.fail(
              new PullRequestError({
                reason: "dev-mode-off",
                detail: "Pull requests are part of Dev mode.",
              }),
            ),
      ),
    );

    const readRemote = (project: {
      readonly id: string;
      readonly title: string;
      readonly workspaceRoot: string;
    }) =>
      Effect.gen(function* () {
        const cached = remotes.get(project.id);
        if (cached !== undefined && nowMs() - cached.atMs < PROJECT_REMOTE_TTL_MS) {
          return cached.remote;
        }
        const handle = yield* sourceControl
          .resolveHandle({ cwd: project.workspaceRoot })
          .pipe(Effect.option, Effect.map(Option.getOrNull));
        const context = handle?.context ?? null;
        const repository = context === null ? null : parseRemoteRepositoryPath(context.remoteUrl);
        let remote: ProjectRemote | null = null;
        if (handle !== null && context !== null && repository !== null) {
          remote = {
            projectId: project.id,
            projectTitle: project.title,
            cwd: project.workspaceRoot,
            kind: context.provider.kind,
            hostname: new URL(context.provider.baseUrl).hostname,
            repository,
            host: handle.provider.pullRequestHost?.() ?? null,
          };
        }
        remotes.set(project.id, { atMs: nowMs(), remote });
        return remote;
      });

    const projectRemotes = (projectId?: string) =>
      projections.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new PullRequestError({ reason: "host", detail: "Couldn't read this computer's list." }),
        ),
        Effect.flatMap((snapshot) =>
          Effect.forEach(
            snapshot.projects.filter(
              (project) => projectId === undefined || project.id === projectId,
            ),
            readRemote,
            { concurrency: PROJECT_CONCURRENCY },
          ),
        ),
        Effect.map((found) => found.filter((remote) => remote !== null)),
      );

    const refOf = (input: PullRequestRef) =>
      Effect.gen(function* () {
        yield* requireDevMode;
        if (!isRepositoryName(input.repository)) {
          return yield* new PullRequestError({
            reason: "not-found",
            detail: "That doesn't look like a repository.",
          });
        }
        const [remote] = yield* projectRemotes(input.projectId);
        if (remote === undefined) {
          return yield* new PullRequestError({
            reason: "not-found",
            detail: "This project has no hosted repository.",
          });
        }
        const host = remote.host;
        if (host === null) {
          return yield* new PullRequestError({
            reason: "unsupported",
            detail: `Pull requests for ${PROVIDER_LABELS[remote.kind]} aren't in Work yet.`,
          });
        }
        return {
          remote,
          host,
          target: { cwd: remote.cwd, repository: input.repository, number: input.number },
        };
      });

    const hostFailure = (host: PullRequestHostShape) => (error: SourceControlProviderError) =>
      toPullRequestError(host.label, error);

    const list: PullRequestsShape["list"] = (input) =>
      Effect.gen(function* () {
        yield* requireDevMode;
        const found = yield* projectRemotes(input.projectId);
        const groups = Map.groupBy(found, (remote) => `${remote.kind}:${remote.hostname}`);
        const answers = yield* Effect.forEach(
          groups.values(),
          (group) => {
            const first = group[0]!;
            const label = first.host?.label ?? PROVIDER_LABELS[first.kind];
            const summary = (
              configured: boolean,
              detail: string | null,
            ): PullRequestProviderSummary => ({
              host: first.hostname as PullRequestProviderSummary["host"],
              kind: first.kind,
              label: label as PullRequestProviderSummary["label"],
              projectCount: group.length as PullRequestProviderSummary["projectCount"],
              configured,
              detail: detail as PullRequestProviderSummary["detail"],
              capabilities: first.host?.capabilities ?? {
                actions: [],
                mergeMethods: [],
                diff: false,
                comment: false,
                viewedFiles: false,
                mergeMessageRewrite: false,
                deleteBranch: false,
              },
            });
            const host = first.host;
            if (host === null) {
              return Effect.succeed({
                summary: summary(false, `Pull requests for ${label} aren't in Work yet.`),
                viewer: null,
                entries: [] as ReadonlyArray<PullRequestListEntry>,
                truncated: false,
              });
            }
            const byRepository = new Map(
              group.toReversed().map((remote) => [remote.repository.toLowerCase(), remote]),
            );
            return host
              .list({
                cwd: first.cwd,
                repositories: [...new Set(group.map((remote) => remote.repository))],
                state: input.state,
                involvement: input.involvement ?? "all",
                ...(input.query !== undefined ? { query: input.query } : {}),
              })
              .pipe(
                Effect.map((answer) => ({
                  summary: summary(true, null),
                  viewer: answer.viewer,
                  entries: answer.rows.map((row): PullRequestListEntry => {
                    const remote = byRepository.get(row.repository.toLowerCase()) ?? first;
                    return {
                      ...row,
                      projectId: remote.projectId as PullRequestListEntry["projectId"],
                      projectTitle: remote.projectTitle as PullRequestListEntry["projectTitle"],
                    };
                  }),
                  truncated: answer.truncated,
                })),
                Effect.catch((error) =>
                  Effect.logWarning("pull requests: list skipped").pipe(
                    Effect.annotateLogs({ host: first.hostname }),
                    Effect.as({
                      summary: summary(false, toPullRequestError(label, error).detail),
                      viewer: null,
                      entries: [] as ReadonlyArray<PullRequestListEntry>,
                      truncated: false,
                    }),
                  ),
                ),
              );
          },
          { concurrency: 3 },
        );
        const viewers: Record<string, string> = {};
        for (const answer of answers) {
          if (answer.viewer !== null) viewers[answer.summary.host] = answer.viewer;
        }
        return {
          viewers,
          providers: answers.map((answer) => answer.summary),
          entries: answers
            .flatMap((answer) => answer.entries)
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          truncated: answers.some((answer) => answer.truncated),
        };
      });

    const detail: PullRequestsShape["detail"] = (input) =>
      Effect.gen(function* () {
        const { remote, host, target } = yield* refOf(input);
        const read = yield* host.detail(target).pipe(Effect.mapError(hostFailure(host)));
        return {
          ...read,
          capabilities: host.capabilities,
          projectId: remote.projectId as PullRequestDetailView["projectId"],
          projectTitle: remote.projectTitle as PullRequestDetailView["projectTitle"],
        };
      });

    const diff: PullRequestsShape["diff"] = (input) =>
      Effect.gen(function* () {
        const { host, target } = yield* refOf(input);
        const read = host.diff;
        if (read === undefined) {
          return yield* new PullRequestError({
            reason: "unsupported",
            detail: `${host.label} changes open on its site.`,
          });
        }
        if (input.commit !== undefined && !isCommitSha(input.commit)) {
          return yield* new PullRequestError({
            reason: "not-found",
            detail: "That doesn't look like a commit.",
          });
        }
        return yield* read({
          ...target,
          ...(input.commit !== undefined ? { commit: input.commit } : {}),
        }).pipe(Effect.mapError(hostFailure(host)));
      });

    const runAction: PullRequestsShape["runAction"] = (input) =>
      Effect.gen(function* () {
        const { remote, host, target } = yield* refOf(input);
        if (!host.capabilities.actions.includes(input.action)) {
          return yield* new PullRequestError({
            reason: "unsupported",
            detail: `${host.label} doesn't have this action.`,
          });
        }
        const merging = input.action === "merge" || input.action === "enable-auto-merge";
        const removeAgentCredits =
          merging && host.capabilities.mergeMessageRewrite
            ? yield* settings.getSettings.pipe(
                Effect.map(
                  (current) =>
                    resolveProjectSettings(current, remote.projectId).settings
                      .removeAgentCreditsOnMerge,
                ),
                Effect.orElseSucceed(() => false),
              )
            : false;
        const result = yield* host
          .runAction({
            ...target,
            action: input.action,
            ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
            ...(input.deleteBranch !== undefined ? { deleteBranch: input.deleteBranch } : {}),
            ...(removeAgentCredits ? { removeAgentCredits: true } : {}),
          })
          .pipe(Effect.mapError(hostFailure(host)));
        yield* Effect.logInfo("pull request action").pipe(
          Effect.annotateLogs({
            action: input.action,
            repository: input.repository,
            number: input.number,
          }),
        );
        // The chat's row shouldn't wait for the next sweep to say "merged".
        yield* threads.refreshLinked({ repository: input.repository, number: input.number });
        return result;
      });

    const setFileViewed: PullRequestsShape["setFileViewed"] = (input) =>
      Effect.gen(function* () {
        const { host, target } = yield* refOf(input);
        const mark = host.setFileViewed;
        if (mark === undefined) {
          return yield* new PullRequestError({
            reason: "unsupported",
            detail: `${host.label} doesn't keep viewed marks.`,
          });
        }
        yield* mark({ ...target, path: input.path, viewed: input.viewed }).pipe(
          Effect.mapError(hostFailure(host)),
        );
      });

    const comment: PullRequestsShape["comment"] = (input) =>
      Effect.gen(function* () {
        const { host, target } = yield* refOf(input);
        const post = host.comment;
        if (post === undefined) {
          return yield* new PullRequestError({
            reason: "unsupported",
            detail: `Comment on ${host.label}'s site.`,
          });
        }
        yield* post({ ...target, body: input.body }).pipe(Effect.mapError(hostFailure(host)));
      });

    return { list, detail, diff, runAction, setFileViewed, comment } satisfies PullRequestsShape;
  });

export const PullRequestsLive = Layer.effect(PullRequests, makePullRequests());
