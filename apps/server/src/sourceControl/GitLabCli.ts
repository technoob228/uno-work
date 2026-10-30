import { Context, Effect, Layer, Option, Result, Schema, SchemaIssue, type DateTime } from "effect";

import { TrimmedNonEmptyString, type SourceControlRepositoryVisibility } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabMergeRequests from "./gitLabMergeRequests.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_READ_CONCURRENCY = 3;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class GitLabCliError extends Schema.TaggedErrorClass<GitLabCliError>()("GitLabCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface GitLabMergeRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitLabRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GitLabCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitLabCliError>;

  readonly listMergeRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitLabMergeRequestSummary>, GitLabCliError>;

  readonly getMergeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitLabMergeRequestSummary, GitLabCliError>;

  readonly readMergeRequestStatuses: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
    readonly branches: ReadonlyArray<string>;
  }) => Effect.Effect<SourceControlProvider.ChangeRequestStatusRead, GitLabCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

  readonly createMergeRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, GitLabCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitLabCliError>;

  readonly checkoutMergeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitLabCliError>;
}

export class GitLabCli extends Context.Service<GitLabCli, GitLabCliShape>()(
  "t3/source-control/GitLabCli",
) {}

function isVcsProcessSpawnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VcsProcessSpawnError"
  );
}

function normalizeGitLabCliError(operation: "execute" | "stdout", error: unknown): GitLabCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: glab") || isVcsProcessSpawnError(error)) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI (`glab`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("glab auth login") ||
      lower.includes("token")
    ) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("merge request not found") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      return new GitLabCliError({
        operation,
        detail: "Merge request not found. Check the MR number or URL and try again.",
        cause: error,
      });
    }

    return new GitLabCliError({
      operation,
      detail: `GitLab CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitLabCliError({
    operation,
    detail: "GitLab CLI command failed.",
    cause: error,
  });
}

const RawGitLabRepositoryCloneUrlsSchema = Schema.Struct({
  path_with_namespace: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  http_url_to_repo: TrimmedNonEmptyString,
  ssh_url_to_repo: TrimmedNonEmptyString,
});

const RawGitLabDefaultBranchSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const RawGitLabNamespaceSchema = Schema.Struct({
  id: Schema.Number,
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitLabRepositoryCloneUrlsSchema>,
): GitLabRepositoryCloneUrls {
  return {
    nameWithOwner: raw.path_with_namespace,
    url: raw.web_url,
    sshUrl: raw.ssh_url_to_repo,
  };
}

function decodeGitLabJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch" | "createRepository",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitLabCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitLabCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

function stateArgs(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return [];
    case "closed":
      return ["--closed"];
    case "merged":
      return ["--merged"];
    case "all":
      return ["--all"];
  }
}

function normalizeHeadSelector(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerBranch = /^[^:]+:(.+)$/.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

function sourceProjectIdentifier(
  source: SourceControlProvider.SourceControlRefSelector | undefined,
): string | null {
  return source?.repository ?? source?.owner ?? null;
}

function toSummaryWithOptionalUpdatedAt(
  record: GitLabMergeRequestSummary & {
    readonly updatedAt: Option.Option<DateTime.Utc>;
  },
): GitLabMergeRequestSummary {
  const { updatedAt, ...summary } = record;
  return Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

function parseRepositoryPath(repository: string): {
  readonly namespacePath: string | null;
  readonly projectPath: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const projectPath = parts.at(-1) ?? repository.trim();
  const namespacePath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { namespacePath, projectPath };
}

export const make = Effect.fn("makeGitLabCli")(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitLabCliShape["execute"] = (input) =>
    process
      .run({
        operation: "GitLabCli.execute",
        command: "glab",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => normalizeGitLabCliError("execute", error)));

  return GitLabCli.of({
    execute,
    listMergeRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "mr",
          "list",
          "--source-branch",
          sourceRefName(input),
          ...stateArgs(input.state),
          "--per-page",
          String(input.limit ?? 20),
          "--output",
          "json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => GitLabMergeRequests.decodeGitLabMergeRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitLabCliError({
                        operation: "listMergeRequests",
                        detail: `GitLab CLI returned invalid MR list JSON: ${GitLabMergeRequests.formatGitLabJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success.map(toSummaryWithOptionalUpdatedAt));
                }),
              ),
        ),
      ),
    getMergeRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["mr", "view", input.reference, "--output", "json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => GitLabMergeRequests.decodeGitLabMergeRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitLabCliError({
                    operation: "getMergeRequest",
                    detail: `GitLab CLI returned invalid merge request JSON: ${GitLabMergeRequests.formatGitLabJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(toSummaryWithOptionalUpdatedAt(decoded.success));
            }),
          ),
        ),
      ),
    readMergeRequestStatuses: (input) =>
      Effect.gen(function* () {
        // GitLab has no document to batch into, but it allows 2000 requests a minute.
        const views = yield* Effect.forEach(
          input.numbers,
          (number) =>
            execute({
              cwd: input.cwd,
              args: ["mr", "view", String(number), "--repo", input.repository, "--output", "json"],
            }).pipe(
              Effect.map((result) => parseJson(result.stdout)),
              Effect.map(GitLabMergeRequests.decodeGitLabMergeRequestStatus),
              // One merge request that is gone must not cost the rest their read.
              Effect.catch((error) =>
                error.detail.includes("404") ? Effect.succeed(null) : Effect.fail(error),
              ),
            ),
          { concurrency: STATUS_READ_CONCURRENCY },
        );
        const lists = yield* Effect.forEach(
          input.branches,
          (branch) =>
            execute({
              cwd: input.cwd,
              args: [
                "mr",
                "list",
                "--source-branch",
                branch,
                ...stateArgs("all"),
                "--per-page",
                "3",
                "--repo",
                input.repository,
                "--output",
                "json",
              ],
            }).pipe(
              Effect.map((result) => {
                const entries = parseJson(result.stdout);
                const statuses = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
                  const status = GitLabMergeRequests.decodeGitLabMergeRequestStatus(entry);
                  return status === null ? [] : [status];
                });
                return [branch, statuses] as const;
              }),
            ),
          { concurrency: STATUS_READ_CONCURRENCY },
        );
        return {
          byNumber: new Map(
            views.flatMap((status) => (status === null ? [] : [[status.number, status] as const])),
          ),
          byBranch: new Map(lists),
          budget: null,
        };
      }),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `projects/${encodeURIComponent(input.repository)}`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const { namespacePath, projectPath } = parseRepositoryPath(input.repository);
      const namespaceId: Effect.Effect<number | null, GitLabCliError> = namespacePath
        ? execute({
            cwd: input.cwd,
            args: ["api", `namespaces/${encodeURIComponent(namespacePath)}`],
          }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.flatMap((raw) =>
              decodeGitLabJson(
                raw,
                RawGitLabNamespaceSchema,
                "createRepository",
                "GitLab CLI returned invalid namespace JSON.",
              ),
            ),
            Effect.map((namespace) => namespace.id),
          )
        : Effect.succeed(null);

      return namespaceId.pipe(
        Effect.flatMap((resolvedNamespaceId) =>
          execute({
            cwd: input.cwd,
            args: [
              "api",
              "--method",
              "POST",
              "projects",
              "--raw-field",
              `path=${projectPath}`,
              "--raw-field",
              `name=${projectPath}`,
              "--raw-field",
              `visibility=${input.visibility}`,
              ...(resolvedNamespaceId === null
                ? []
                : ["--raw-field", `namespace_id=${resolvedNamespaceId}`]),
            ],
          }),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "createRepository",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createMergeRequest: (input) => {
      const sourceProject = sourceProjectIdentifier(input.source);
      return execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "POST",
          "projects/:fullpath/merge_requests",
          "--raw-field",
          `source_branch=${sourceRefName(input)}`,
          "--raw-field",
          `target_branch=${input.target?.refName ?? input.baseBranch}`,
          ...(sourceProject ? ["--raw-field", `source_project_id=${sourceProject}`] : []),
          "--raw-field",
          `title=${input.title}`,
          "--field",
          `description=@${input.bodyFile}`,
        ],
      }).pipe(Effect.asVoid);
    },
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "projects/:fullpath"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabDefaultBranchSchema,
            "getDefaultBranch",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((value) => value.default_branch ?? null),
      ),
    checkoutMergeRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["mr", "checkout", input.reference],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitLabCli, make());
