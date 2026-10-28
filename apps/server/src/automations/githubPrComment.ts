/**
 * `github_pr_comment` — the `uno-work` tool that posts a comment on a pull
 * request through the Uno GitHub App (`uno-deploy[bot]`): the console mints
 * an installation token narrowed to that one repository and
 * `pull_requests: write` (CONTRACT.md, `/work/git/github/pr-comment`).
 *
 * An outward step: in Ask mode and for an "Asks first" assistant it waits
 * for the person's Allow ("Comment on PR #12 in owner/x", the start of the
 * text as the detail); "Does it itself" posts at once. Open to an
 * assistant's own conversation (it is the review's last step, not work) and
 * to every chat.
 *
 * @module automations/githubPrComment
 */
import type { ServerSettings } from "@t3tools/contracts";
import { Effect } from "effect";

import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import type { ObjectSchema } from "../unoWork/argsSchema.ts";
import type { ConsoleReply, ConsoleRequest } from "../unoWork/consoleClient.ts";
import { consoleRefusal } from "./consoleClient.ts";

export const GITHUB_PR_COMMENT_TOOL = "github_pr_comment";
export const PR_COMMENT_MAX_CHARS = 60_000;
const REPO_PATTERN = "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$";

/** What the tool needs from `uno-work`'s deps (kept narrow: no import cycle). */
export interface PrCommentDeps {
  readonly settings: Effect.Effect<ServerSettings, { readonly message: string }>;
  readonly console?: {
    readonly request: (
      input: ConsoleRequest,
    ) => Effect.Effect<ConsoleReply, { readonly message: string }>;
  };
  readonly connectors?: {
    readonly access?: (input: {
      readonly provider: string;
      readonly changesThings: boolean;
    }) => Effect.Effect<{
      readonly decision: "allow" | "none" | "read-only";
      readonly assistant: string | null;
    }>;
  };
}

export interface PrCommentKit<E> {
  readonly fail: (message: string) => E;
}

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : "";

/** "Comment on PR #12 in owner/x". */
export function prCommentTitle(args: Record<string, unknown>): string {
  const number = typeof args["number"] === "number" ? args["number"] : "?";
  return `Comment on PR #${number} in ${str(args, "repo") || "a repository"}`;
}

/** The first lines of the comment, for the approval card. */
export function prCommentDetail(args: Record<string, unknown>): string | undefined {
  const lines = str(args, "body")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 4)
    .join("\n");
  if (lines.length === 0) return undefined;
  return lines.length > 300 ? `${lines.slice(0, 299)}…` : lines;
}

/** A console refusal → the line the model reads (with the link to fix it). */
export function prCommentProblem(reply: {
  readonly status: number;
  readonly body: unknown;
}): string {
  if (reply.status === 413) {
    return `The comment is too long for GitHub (over ${PR_COMMENT_MAX_CHARS.toLocaleString("en-US")} characters): shorten it and post again.`;
  }
  if (reply.status === 429) {
    return "This computer posted as many pull request comments this hour as it may (30). Tell the person; post later.";
  }
  const refusal = consoleRefusal({ status: reply.status, body: reply.body });
  const link = refusal.manageUrl ?? refusal.connectUrl;
  return link !== undefined
    ? `${refusal.message} Tell the person in one line and give them the link; don't post another way.`
    : refusal.code === "AUTOMATIONS_DISABLED"
      ? "Commenting on pull requests isn't switched on for this Uno account yet. Tell the person; don't post another way (no gh or curl)."
      : `${refusal.message} Don't post another way (no gh or curl).`;
}

/** The tool definition; `kit.fail` makes `uno-work`'s own tool error. */
export function githubPrCommentTool<E>(kit: PrCommentKit<E>) {
  return {
    name: GITHUB_PR_COMMENT_TOOL,
    group: "account" as const,
    description:
      "Post a comment on a GitHub pull request as the Uno GitHub app (uno-deploy[bot]) — e.g. the review an automation asked for. Markdown body. The repository must be in the person's Uno GitHub app; GitHub then shows the comment from uno-deploy[bot]. In Ask mode and for an assistant that asks first it waits for the person's Allow.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", pattern: REPO_PATTERN, description: "owner/name" },
        number: { type: "integer", minimum: 1, description: "The pull request's number." },
        body: {
          type: "string",
          minLength: 1,
          maxLength: PR_COMMENT_MAX_CHARS,
          description: "The comment, in Markdown.",
        },
      },
      required: ["repo", "number", "body"],
      additionalProperties: false,
    } satisfies ObjectSchema,
    level: "change" as const,
    approvalTitle: prCommentTitle,
    approvalDetail: prCommentDetail,
    /** No card for a call that can't work: the assistant's GitHub level first. */
    prepare: (deps: PrCommentDeps, _args: Record<string, unknown>): Effect.Effect<void, E> =>
      Effect.gen(function* () {
        const access = deps.connectors?.access
          ? yield* deps.connectors.access({ provider: "github", changesThings: true })
          : null;
        if (access !== null && access.decision !== "allow") {
          const who = access.assistant ?? "This assistant";
          return yield* Effect.fail(
            kit.fail(
              access.decision === "none"
                ? `${who} isn't allowed to open GitHub. The person can change that on ${who}'s page in Uno Work (Apps it can open). Tell them; don't retry or work around it.`
                : `${who} may only read GitHub; a comment would change something. The person can allow changes on ${who}'s page in Uno Work. Tell them; don't retry.`,
            ),
          );
        }
      }),
    run: (deps: PrCommentDeps, args: Record<string, unknown>): Effect.Effect<unknown, E> =>
      Effect.gen(function* () {
        const settings = yield* deps.settings.pipe(Effect.mapError((e) => kit.fail(e.message)));
        const boxId = parseSettingsBoxId(settings.uno.boxId);
        if (boxId === null || deps.console === undefined) {
          return yield* Effect.fail(
            kit.fail(
              "Comments on GitHub through Uno work from an Uno cloud computer; this one isn't linked to the Uno console. Tell the person; don't post another way.",
            ),
          );
        }
        const reply = yield* deps.console
          .request({
            method: "POST",
            path: `/api/v1/boxes/${boxId}/work/git/github/pr-comment`,
            body: { repo: str(args, "repo"), number: args["number"], body: str(args, "body") },
          })
          .pipe(
            Effect.mapError((cause) =>
              kit.fail(`The Uno console didn't answer (${cause.message}). Try again in a minute.`),
            ),
          );
        if (reply.status < 200 || reply.status >= 300) {
          return yield* Effect.fail(kit.fail(prCommentProblem(reply)));
        }
        const body =
          typeof reply.body === "object" && reply.body !== null
            ? (reply.body as Record<string, unknown>)
            : {};
        const url = typeof body["html_url"] === "string" ? body["html_url"] : null;
        return {
          ok: true,
          commentUrl: url,
          note: "Posted. Tell the person in one line, with the link.",
        };
      }),
  };
}
