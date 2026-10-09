import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import { ManagerConnectorKind } from "../Services/ManagerConnectors.ts";
import {
  ConnectorPendingReplyStatus,
  ConnectorReplyLanguage,
  ManagerConnectorPendingReplyRepository,
  type ConnectorPendingReply,
  type ManagerConnectorPendingReplyRepositoryShape,
} from "../Services/ManagerConnectorPendingReplies.ts";

const PendingReplyDbRow = Schema.Struct({
  kind: ManagerConnectorKind,
  connectorProjectId: ProjectId,
  replyKey: Schema.String,
  chatId: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  replyThread: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  userMessageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  requestedAt: Schema.String,
  language: ConnectorReplyLanguage,
  meta: Schema.fromJsonString(Schema.Unknown),
  status: ConnectorPendingReplyStatus,
  progressNotes: Schema.Number,
  resumeAttempts: Schema.Number,
  deliveredParts: Schema.Number,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const WriteRequest = Schema.Struct({
  kind: ManagerConnectorKind,
  connectorProjectId: ProjectId,
  replyKey: Schema.String,
  chatId: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  replyThread: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  userMessageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  requestedAt: Schema.String,
  language: ConnectorReplyLanguage,
  metaJson: Schema.String,
  status: ConnectorPendingReplyStatus,
  progressNotes: Schema.Number,
  resumeAttempts: Schema.Number,
  deliveredParts: Schema.Number,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const KeyRequest = Schema.Struct({
  kind: ManagerConnectorKind,
  connectorProjectId: ProjectId,
  replyKey: Schema.String,
});

const withRepositoryError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ManagerRepositoryError, R> =>
    effect.pipe(
      Effect.mapError((cause: unknown) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError(`ManagerConnectorPendingReplyRepository.${operation}:decode`)(
              cause,
            )
          : toPersistenceSqlError(`ManagerConnectorPendingReplyRepository.${operation}:query`)(
              cause,
            ),
      ),
    );

const toWrite = (row: ConnectorPendingReply): typeof WriteRequest.Type => {
  const { meta, ...rest } = row;
  return { ...rest, metaJson: JSON.stringify(meta ?? {}) };
};

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectColumns = sql`
    kind AS "kind",
    connector_project_id AS "connectorProjectId",
    reply_key AS "replyKey",
    chat_id AS "chatId",
    reply_to AS "replyTo",
    reply_thread AS "replyThread",
    thread_id AS "threadId",
    user_message_id AS "userMessageId",
    turn_id AS "turnId",
    requested_at AS "requestedAt",
    language AS "language",
    meta_json AS "meta",
    status AS "status",
    progress_notes AS "progressNotes",
    resume_attempts AS "resumeAttempts",
    delivered_parts AS "deliveredParts",
    error AS "error",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const insertRow = SqlSchema.void({
    Request: WriteRequest,
    execute: (row) => sql`
      INSERT OR IGNORE INTO manager_connector_pending_replies (
        kind, connector_project_id, reply_key, chat_id, reply_to, reply_thread,
        thread_id, user_message_id, turn_id, requested_at, language, meta_json,
        status, progress_notes, resume_attempts, delivered_parts, error,
        created_at, updated_at
      ) VALUES (
        ${row.kind}, ${row.connectorProjectId}, ${row.replyKey}, ${row.chatId},
        ${row.replyTo}, ${row.replyThread}, ${row.threadId}, ${row.userMessageId},
        ${row.turnId}, ${row.requestedAt}, ${row.language}, ${row.metaJson},
        ${row.status}, ${row.progressNotes}, ${row.resumeAttempts},
        ${row.deliveredParts}, ${row.error}, ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const saveRow = SqlSchema.void({
    Request: WriteRequest,
    execute: (row) => sql`
      INSERT INTO manager_connector_pending_replies (
        kind, connector_project_id, reply_key, chat_id, reply_to, reply_thread,
        thread_id, user_message_id, turn_id, requested_at, language, meta_json,
        status, progress_notes, resume_attempts, delivered_parts, error,
        created_at, updated_at
      ) VALUES (
        ${row.kind}, ${row.connectorProjectId}, ${row.replyKey}, ${row.chatId},
        ${row.replyTo}, ${row.replyThread}, ${row.threadId}, ${row.userMessageId},
        ${row.turnId}, ${row.requestedAt}, ${row.language}, ${row.metaJson},
        ${row.status}, ${row.progressNotes}, ${row.resumeAttempts},
        ${row.deliveredParts}, ${row.error}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT(kind, connector_project_id, reply_key) DO UPDATE SET
        chat_id = excluded.chat_id,
        reply_to = excluded.reply_to,
        reply_thread = excluded.reply_thread,
        thread_id = excluded.thread_id,
        user_message_id = excluded.user_message_id,
        turn_id = excluded.turn_id,
        requested_at = excluded.requested_at,
        language = excluded.language,
        meta_json = excluded.meta_json,
        status = excluded.status,
        progress_notes = excluded.progress_notes,
        resume_attempts = excluded.resume_attempts,
        delivered_parts = excluded.delivered_parts,
        error = excluded.error,
        updated_at = excluded.updated_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: KeyRequest,
    Result: PendingReplyDbRow,
    execute: ({ kind, connectorProjectId, replyKey }) => sql`
      SELECT ${selectColumns}
      FROM manager_connector_pending_replies
      WHERE kind = ${kind} AND connector_project_id = ${connectorProjectId} AND reply_key = ${replyKey}
    `,
  });

  const listOpenRows = SqlSchema.findAll({
    Request: Schema.Struct({ kind: ManagerConnectorKind }),
    Result: PendingReplyDbRow,
    execute: ({ kind }) => sql`
      SELECT ${selectColumns}
      FROM manager_connector_pending_replies
      WHERE kind = ${kind} AND status IN ('queued', 'waiting')
      ORDER BY created_at ASC, reply_key ASC
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, limit: Schema.Number }),
    Result: PendingReplyDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT * FROM (
        SELECT ${selectColumns}
        FROM manager_connector_pending_replies
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, reply_key DESC
        LIMIT ${limit}
      ) ORDER BY "createdAt" ASC, "replyKey" ASC
    `,
  });

  const pruneRows = SqlSchema.void({
    Request: Schema.Struct({ before: Schema.String }),
    execute: ({ before }) => sql`
      DELETE FROM manager_connector_pending_replies
      WHERE status IN ('delivered', 'failed') AND updated_at < ${before}
    `,
  });

  const insertIfAbsent: ManagerConnectorPendingReplyRepositoryShape["insertIfAbsent"] = (row) =>
    Effect.gen(function* () {
      const existing = yield* getRow(row);
      if (Option.isSome(existing)) return false;
      yield* insertRow(toWrite(row));
      return true;
    }).pipe(withRepositoryError("insertIfAbsent"));

  return {
    insertIfAbsent,
    save: (row) => saveRow(toWrite(row)).pipe(withRepositoryError("save")),
    get: (key) => getRow(key).pipe(withRepositoryError("get")),
    listOpen: (kind) => listOpenRows({ kind }).pipe(withRepositoryError("listOpen")),
    listByThread: (input) => listThreadRows(input).pipe(withRepositoryError("listByThread")),
    prune: (input) => pruneRows(input).pipe(withRepositoryError("prune")),
  } satisfies ManagerConnectorPendingReplyRepositoryShape;
});

export const ManagerConnectorPendingReplyRepositoryLive = Layer.effect(
  ManagerConnectorPendingReplyRepository,
  makeRepository,
);
