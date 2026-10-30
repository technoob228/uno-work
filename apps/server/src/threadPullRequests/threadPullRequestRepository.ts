/**
 * The one read the PR sweep runs every minute: threads that have a branch or a
 * PR, without the turns, sessions and messages a shell snapshot carries. On a
 * database of gigabytes that difference is what lets the sweep stay quiet.
 */
import { ThreadPullRequest } from "@t3tools/contracts";
import { Effect, Exit, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SweepThread } from "./threadPullRequestRules.ts";

interface Row {
  readonly threadId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pullRequests: string | null;
  readonly settledOverride: string | null;
  readonly pinnedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly autoSettleDisabledAt: string | null;
  readonly latestPersonMessageAt: string | null;
  readonly latestUserMessageAt: string | null;
}

const decodeLinks = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(ThreadPullRequest)),
);

const toSweepThread = (row: Row): SweepThread => {
  const links = row.pullRequests === null ? null : decodeLinks(row.pullRequests);
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    workspaceRoot: row.workspaceRoot,
    branch: row.branch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // A row we can't read is rewritten by the next sync rather than stopping the sweep.
    pullRequests: links !== null && Exit.isSuccess(links) ? links.value : [],
    settledOverride:
      row.settledOverride === "settled" || row.settledOverride === "active"
        ? row.settledOverride
        : null,
    pinnedAt: row.pinnedAt,
    snoozedUntil: row.snoozedUntil,
    autoSettleDisabledAt: row.autoSettleDisabledAt,
    latestPersonMessageAt: row.latestPersonMessageAt,
    latestUserMessageAt: row.latestUserMessageAt,
  };
};

export const makeThreadPullRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`
    thread.thread_id AS "threadId",
    thread.project_id AS "projectId",
    project.workspace_root AS "workspaceRoot",
    thread.branch AS "branch",
    thread.created_at AS "createdAt",
    thread.updated_at AS "updatedAt",
    thread.pull_requests_json AS "pullRequests",
    thread.settled_override AS "settledOverride",
    thread.pinned_at AS "pinnedAt",
    thread.snoozed_until AS "snoozedUntil",
    thread.auto_settle_disabled_at AS "autoSettleDisabledAt",
    thread.latest_person_message_at AS "latestPersonMessageAt",
    thread.latest_user_message_at AS "latestUserMessageAt"
  `;

  return {
    /** Every thread a PR can matter to right now; settled ones are left alone. */
    list: sql<Row>`
      SELECT ${columns}
      FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE thread.deleted_at IS NULL
        AND thread.archived_at IS NULL
        AND project.deleted_at IS NULL
        AND (thread.branch IS NOT NULL OR thread.pull_requests_json IS NOT NULL)
        AND (thread.settled_override IS NULL OR thread.settled_override != 'settled')
    `.pipe(Effect.map((rows) => rows.map(toSweepThread))),
    /** One thread, also before it has a branch or a PR: `gh pr create` may be its first. */
    get: (threadId: string) =>
      sql<Row>`
        SELECT ${columns}
        FROM projection_threads AS thread
        JOIN projection_projects AS project ON project.project_id = thread.project_id
        WHERE thread.thread_id = ${threadId}
          AND thread.deleted_at IS NULL
          AND thread.archived_at IS NULL
          AND project.deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined ? null : toSweepThread(row);
        }),
      ),
  };
});
