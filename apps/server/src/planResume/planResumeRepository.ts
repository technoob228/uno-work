/**
 * Durable waits of `plan_resumes` plus the two small reads of a chat's tail the
 * service needs on every turn end: one indexed row each, not the whole thread.
 */
import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

import type { PlanResumeRow, ThreadTail } from "./planResumeRules.ts";

export type PlanResumeEndStatus = "dispatched" | "cancelled" | "failed";

interface Row {
  readonly resumeId: string;
  readonly threadId: string;
  readonly stoppedTurnId: string | null;
  readonly lastUserMessageId: string | null;
  readonly resumeAt: string;
}

const toRow = (row: Row): PlanResumeRow => ({
  resumeId: row.resumeId,
  threadId: row.threadId as ThreadId,
  stoppedTurnId: row.stoppedTurnId as TurnId | null,
  lastUserMessageId: row.lastUserMessageId,
  resumeAt: row.resumeAt,
});

export const makePlanResumeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`
    resume_id AS "resumeId",
    thread_id AS "threadId",
    stopped_turn_id AS "stoppedTurnId",
    last_user_message_id AS "lastUserMessageId",
    resume_at AS "resumeAt"
  `;

  const threadTail = (threadId: ThreadId): Effect.Effect<ThreadTail, unknown> =>
    Effect.gen(function* () {
      const latest = yield* sql<{
        readonly role: string;
        readonly text: string;
        readonly streaming: number;
        readonly createdAt: string;
      }>`
        SELECT role, text, is_streaming AS "streaming", created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const user = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const row = latest[0];
      return {
        latest: row ? { ...row, streaming: row.streaming !== 0 } : null,
        lastUserMessageId: user[0]?.messageId ?? null,
      };
    });

  /** This request already had a wait, whatever became of it. */
  const caseSeen = (input: {
    readonly threadId: ThreadId;
    readonly lastUserMessageId: string | null;
  }) =>
    sql<{ readonly total: number }>`
      SELECT COUNT(*) AS "total"
      FROM plan_resumes
      WHERE thread_id = ${input.threadId}
        AND last_user_message_id IS ${input.lastUserMessageId}
    `.pipe(Effect.map((rows) => (rows[0]?.total ?? 0) > 0));

  const insert = (input: PlanResumeRow & { readonly now: string }) =>
    sql`
      INSERT INTO plan_resumes (
        resume_id, thread_id, stopped_turn_id, last_user_message_id,
        resume_at, status, created_at, updated_at
      )
      VALUES (
        ${input.resumeId}, ${input.threadId}, ${input.stoppedTurnId}, ${input.lastUserMessageId},
        ${input.resumeAt}, 'pending', ${input.now}, ${input.now}
      )
    `.pipe(Effect.asVoid);

  const listDue = (input: { readonly now: string; readonly limit: number }) =>
    sql<Row>`
      SELECT ${columns}
      FROM plan_resumes
      WHERE status = 'pending' AND resume_at <= ${input.now}
      ORDER BY resume_at ASC, resume_id ASC
      LIMIT ${input.limit}
    `.pipe(Effect.map((rows) => rows.map(toRow)));

  const listPending = (limit: number) =>
    sql<Row>`
      SELECT ${columns}
      FROM plan_resumes
      WHERE status = 'pending'
      ORDER BY resume_at ASC, resume_id ASC
      LIMIT ${limit}
    `.pipe(Effect.map((rows) => rows.map(toRow)));

  const pendingForThread = (threadId: ThreadId) =>
    sql<Row>`
      SELECT ${columns}
      FROM plan_resumes
      WHERE thread_id = ${threadId} AND status = 'pending'
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] ? toRow(rows[0]) : null)));

  const reschedule = (input: {
    readonly resumeId: string;
    readonly resumeAt: string;
    readonly now: string;
  }) =>
    sql`
      UPDATE plan_resumes
      SET resume_at = ${input.resumeAt}, updated_at = ${input.now}
      WHERE resume_id = ${input.resumeId} AND status = 'pending'
    `.pipe(Effect.asVoid);

  /** Pending → an end state. False when it had already ended: only one side acts. */
  const end = (input: {
    readonly resumeId: string;
    readonly status: PlanResumeEndStatus;
    readonly reason: string;
    readonly now: string;
  }) =>
    sql<{ readonly resumeId: string }>`
      UPDATE plan_resumes
      SET status = ${input.status}, end_reason = ${input.reason}, updated_at = ${input.now}
      WHERE resume_id = ${input.resumeId} AND status = 'pending'
      RETURNING resume_id AS "resumeId"
    `.pipe(Effect.map((rows) => rows.length > 0));

  return {
    threadTail,
    caseSeen,
    insert,
    listDue,
    listPending,
    pendingForThread,
    reschedule,
    end,
  };
});

export type PlanResumeRepository = Effect.Success<typeof makePlanResumeRepository>;
