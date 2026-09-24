import { ManagerConnectorHealthStatus, ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import {
  ManagerConnectorInboxStatus,
  ManagerConnectorKind,
  ManagerConnectorRepository,
  type ManagerConnectorRepositoryShape,
} from "../Services/ManagerConnectors.ts";

const ConnectorDbRow = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  config: Schema.fromJsonString(Schema.Unknown),
  updatedAt: Schema.String,
});

const ConnectorStateDbRow = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  offset: Schema.Number,
  credentialFingerprint: Schema.NullOr(Schema.String),
  status: Schema.NullOr(ManagerConnectorHealthStatus),
  lastOkAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastErrorAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const ConnectorInboxDbRow = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  providerEventId: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
  receivedAt: Schema.String,
  handledAt: Schema.NullOr(Schema.String),
  status: ManagerConnectorInboxStatus,
  attempts: Schema.Number,
  error: Schema.NullOr(Schema.String),
});

const ConnectorKeyRequest = Schema.Struct({ projectId: ProjectId, kind: ManagerConnectorKind });

const InboxEventKeyRequest = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  providerEventId: Schema.String,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ManagerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const withRepositoryError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ManagerRepositoryError, R> =>
    effect.pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          `ManagerConnectorRepository.${operation}:query`,
          `ManagerConnectorRepository.${operation}:decode`,
        ),
      ),
    );

const makeManagerConnectorRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: ConnectorKeyRequest,
    Result: ConnectorDbRow,
    execute: ({ projectId, kind }) =>
      sql`
        SELECT project_id AS "projectId", kind AS "kind", config_json AS "config", updated_at AS "updatedAt"
        FROM manager_assistant_connectors
        WHERE project_id = ${projectId} AND kind = ${kind}
      `,
  });

  const listRowsByKind = SqlSchema.findAll({
    Request: Schema.Struct({ kind: ManagerConnectorKind }),
    Result: ConnectorDbRow,
    execute: ({ kind }) =>
      sql`
        SELECT project_id AS "projectId", kind AS "kind", config_json AS "config", updated_at AS "updatedAt"
        FROM manager_assistant_connectors
        WHERE kind = ${kind}
        ORDER BY project_id
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      configJson: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ projectId, kind, configJson, updatedAt }) =>
      sql`
        INSERT INTO manager_assistant_connectors (project_id, kind, config_json, updated_at)
        VALUES (${projectId}, ${kind}, ${configJson}, ${updatedAt})
        ON CONFLICT(project_id, kind) DO UPDATE SET
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `,
  });

  const getThreadRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      chatId: Schema.String,
    }),
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ projectId, kind, chatId }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM manager_assistant_connector_threads
        WHERE project_id = ${projectId} AND kind = ${kind} AND chat_id = ${chatId}
      `,
  });

  const listChatThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: () =>
      sql`
        SELECT DISTINCT thread_id AS "threadId"
        FROM manager_assistant_connector_threads
      `,
  });

  const setThreadRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      chatId: Schema.String,
      threadId: ThreadId,
      createdAt: Schema.String,
    }),
    execute: ({ projectId, kind, chatId, threadId, createdAt }) =>
      sql`
        INSERT INTO manager_assistant_connector_threads (project_id, kind, chat_id, thread_id, created_at)
        VALUES (${projectId}, ${kind}, ${chatId}, ${threadId}, ${createdAt})
        ON CONFLICT(project_id, kind, chat_id) DO UPDATE SET thread_id = excluded.thread_id
      `,
  });

  // --- Durable inbox & health state --------------------------------------

  const getStateRow = SqlSchema.findOneOption({
    Request: ConnectorKeyRequest,
    Result: ConnectorStateDbRow,
    execute: ({ projectId, kind }) =>
      sql`
        SELECT project_id AS "projectId", kind AS "kind", poll_offset AS "offset",
               credential_fingerprint AS "credentialFingerprint",
               status AS "status", last_ok_at AS "lastOkAt", last_error AS "lastError",
               last_error_at AS "lastErrorAt", updated_at AS "updatedAt"
        FROM manager_connector_state
        WHERE project_id = ${projectId} AND kind = ${kind}
      `,
  });

  const resetStateRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      credentialFingerprint: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ projectId, kind, credentialFingerprint, updatedAt }) =>
      sql`
        INSERT INTO manager_connector_state (project_id, kind, poll_offset, credential_fingerprint, updated_at)
        VALUES (${projectId}, ${kind}, 0, ${credentialFingerprint}, ${updatedAt})
        ON CONFLICT(project_id, kind) DO UPDATE SET
          poll_offset = 0,
          credential_fingerprint = excluded.credential_fingerprint,
          updated_at = excluded.updated_at
      `,
  });

  const deleteInboxForConnector = SqlSchema.void({
    Request: ConnectorKeyRequest,
    execute: ({ projectId, kind }) =>
      sql`
        DELETE FROM manager_connector_inbox
        WHERE project_id = ${projectId} AND kind = ${kind}
      `,
  });

  const advanceOffsetRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      offset: Schema.Number,
      updatedAt: Schema.String,
    }),
    execute: ({ projectId, kind, offset, updatedAt }) =>
      sql`
        INSERT INTO manager_connector_state (project_id, kind, poll_offset, updated_at)
        VALUES (${projectId}, ${kind}, ${offset}, ${updatedAt})
        ON CONFLICT(project_id, kind) DO UPDATE SET
          poll_offset = MAX(manager_connector_state.poll_offset, excluded.poll_offset),
          updated_at = excluded.updated_at
      `,
  });

  const recordHealthRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      status: ManagerConnectorHealthStatus,
      error: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
    execute: ({ projectId, kind, status, error, at }) =>
      status === "connected"
        ? sql`
            INSERT INTO manager_connector_state (project_id, kind, status, last_ok_at, updated_at)
            VALUES (${projectId}, ${kind}, ${status}, ${at}, ${at})
            ON CONFLICT(project_id, kind) DO UPDATE SET
              status = excluded.status,
              last_ok_at = excluded.last_ok_at,
              updated_at = excluded.updated_at
          `
        : sql`
            INSERT INTO manager_connector_state (project_id, kind, status, last_error, last_error_at, updated_at)
            VALUES (${projectId}, ${kind}, ${status}, ${error}, ${at}, ${at})
            ON CONFLICT(project_id, kind) DO UPDATE SET
              status = excluded.status,
              last_error = excluded.last_error,
              last_error_at = excluded.last_error_at,
              updated_at = excluded.updated_at
          `,
  });

  const insertInboxRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      providerEventId: Schema.String,
      payloadJson: Schema.String,
      receivedAt: Schema.String,
    }),
    execute: ({ projectId, kind, providerEventId, payloadJson, receivedAt }) =>
      sql`
        INSERT OR IGNORE INTO manager_connector_inbox
          (project_id, kind, provider_event_id, payload_json, received_at, status, attempts)
        VALUES (${projectId}, ${kind}, ${providerEventId}, ${payloadJson}, ${receivedAt}, 'received', 0)
      `,
  });

  const getInboxRow = SqlSchema.findOneOption({
    Request: InboxEventKeyRequest,
    Result: ConnectorInboxDbRow,
    execute: ({ projectId, kind, providerEventId }) =>
      sql`
        SELECT project_id AS "projectId", kind AS "kind", provider_event_id AS "providerEventId",
               payload_json AS "payload", received_at AS "receivedAt", handled_at AS "handledAt",
               status AS "status", attempts AS "attempts", error AS "error"
        FROM manager_connector_inbox
        WHERE project_id = ${projectId} AND kind = ${kind} AND provider_event_id = ${providerEventId}
      `,
  });

  const bumpInboxAttempts = SqlSchema.findOne({
    Request: InboxEventKeyRequest,
    Result: Schema.Struct({ attempts: Schema.Number }),
    execute: ({ projectId, kind, providerEventId }) =>
      sql`
        UPDATE manager_connector_inbox
        SET attempts = attempts + 1
        WHERE project_id = ${projectId} AND kind = ${kind} AND provider_event_id = ${providerEventId}
        RETURNING attempts AS "attempts"
      `,
  });

  const markInboxHandledRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      providerEventId: Schema.String,
      handledAt: Schema.String,
    }),
    execute: ({ projectId, kind, providerEventId, handledAt }) =>
      sql`
        UPDATE manager_connector_inbox
        SET status = 'handled', handled_at = ${handledAt}, error = NULL
        WHERE project_id = ${projectId} AND kind = ${kind} AND provider_event_id = ${providerEventId}
      `,
  });

  const markInboxFailedRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      providerEventId: Schema.String,
      error: Schema.String,
      failedAt: Schema.String,
    }),
    execute: ({ projectId, kind, providerEventId, error, failedAt }) =>
      sql`
        UPDATE manager_connector_inbox
        SET status = 'failed', handled_at = ${failedAt}, error = ${error}
        WHERE project_id = ${projectId} AND kind = ${kind} AND provider_event_id = ${providerEventId}
      `,
  });

  const listPendingInboxRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      kind: ManagerConnectorKind,
      limit: Schema.Number,
    }),
    Result: ConnectorInboxDbRow,
    execute: ({ projectId, kind, limit }) =>
      sql`
        SELECT project_id AS "projectId", kind AS "kind", provider_event_id AS "providerEventId",
               payload_json AS "payload", received_at AS "receivedAt", handled_at AS "handledAt",
               status AS "status", attempts AS "attempts", error AS "error"
        FROM manager_connector_inbox
        WHERE project_id = ${projectId} AND kind = ${kind} AND status = 'received'
        ORDER BY received_at ASC, provider_event_id ASC
        LIMIT ${limit}
      `,
  });

  const pruneInboxRows = SqlSchema.void({
    Request: Schema.Struct({ before: Schema.String }),
    execute: ({ before }) =>
      sql`
        DELETE FROM manager_connector_inbox
        WHERE status <> 'received' AND received_at < ${before}
      `,
  });

  const get: ManagerConnectorRepositoryShape["get"] = (input) =>
    getRow(input).pipe(withRepositoryError("get"));

  const listByKind: ManagerConnectorRepositoryShape["listByKind"] = (kind) =>
    listRowsByKind({ kind }).pipe(withRepositoryError("listByKind"));

  const upsert: ManagerConnectorRepositoryShape["upsert"] = ({
    projectId,
    kind,
    config,
    updatedAt,
  }) =>
    upsertRow({ projectId, kind, configJson: JSON.stringify(config), updatedAt }).pipe(
      withRepositoryError("upsert"),
    );

  const getThreadForChat: ManagerConnectorRepositoryShape["getThreadForChat"] = (input) =>
    getThreadRow(input).pipe(
      withRepositoryError("getThreadForChat"),
      Effect.map(Option.map((row) => row.threadId)),
    );

  const listChatThreadIds: ManagerConnectorRepositoryShape["listChatThreadIds"] = () =>
    listChatThreadRows(undefined).pipe(
      withRepositoryError("listChatThreadIds"),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const setThreadForChat: ManagerConnectorRepositoryShape["setThreadForChat"] = (input) =>
    setThreadRow(input).pipe(withRepositoryError("setThreadForChat"));

  const getState: ManagerConnectorRepositoryShape["getState"] = (input) =>
    getStateRow(input).pipe(withRepositoryError("getState"));

  const resetState: ManagerConnectorRepositoryShape["resetState"] = (input) =>
    Effect.gen(function* () {
      yield* resetStateRow(input);
      yield* deleteInboxForConnector({ projectId: input.projectId, kind: input.kind });
    }).pipe(withRepositoryError("resetState"));

  const advanceOffset: ManagerConnectorRepositoryShape["advanceOffset"] = (input) =>
    advanceOffsetRow(input).pipe(withRepositoryError("advanceOffset"));

  const recordHealth: ManagerConnectorRepositoryShape["recordHealth"] = (input) =>
    recordHealthRow(input).pipe(withRepositoryError("recordHealth"));

  const insertInboxEvent: ManagerConnectorRepositoryShape["insertInboxEvent"] = (input) =>
    Effect.gen(function* () {
      // INSERT OR IGNORE + re-read instead of a RETURNING dance: the read
      // also tells a duplicate's current status, which is what callers need
      // to decide between "skip" and "handle".
      const existing = yield* getInboxRow(input);
      if (Option.isSome(existing)) {
        return existing.value.status;
      }
      yield* insertInboxRow({
        projectId: input.projectId,
        kind: input.kind,
        providerEventId: input.providerEventId,
        payloadJson: JSON.stringify(input.payload),
        receivedAt: input.receivedAt,
      });
      return "inserted" as const;
    }).pipe(withRepositoryError("insertInboxEvent"));

  const beginInboxAttempt: ManagerConnectorRepositoryShape["beginInboxAttempt"] = (input) =>
    bumpInboxAttempts(input).pipe(
      withRepositoryError("beginInboxAttempt"),
      Effect.map((row) => row.attempts),
    );

  const markInboxHandled: ManagerConnectorRepositoryShape["markInboxHandled"] = (input) =>
    markInboxHandledRow(input).pipe(withRepositoryError("markInboxHandled"));

  const markInboxFailed: ManagerConnectorRepositoryShape["markInboxFailed"] = (input) =>
    markInboxFailedRow(input).pipe(withRepositoryError("markInboxFailed"));

  const listPendingInbox: ManagerConnectorRepositoryShape["listPendingInbox"] = (input) =>
    listPendingInboxRows(input).pipe(withRepositoryError("listPendingInbox"));

  const getInboxEvent: ManagerConnectorRepositoryShape["getInboxEvent"] = (input) =>
    getInboxRow(input).pipe(withRepositoryError("getInboxEvent"));

  const pruneInbox: ManagerConnectorRepositoryShape["pruneInbox"] = (input) =>
    pruneInboxRows(input).pipe(withRepositoryError("pruneInbox"));

  return {
    get,
    listByKind,
    upsert,
    getThreadForChat,
    listChatThreadIds,
    setThreadForChat,
    getState,
    resetState,
    advanceOffset,
    recordHealth,
    insertInboxEvent,
    beginInboxAttempt,
    markInboxHandled,
    markInboxFailed,
    listPendingInbox,
    getInboxEvent,
    pruneInbox,
  } satisfies ManagerConnectorRepositoryShape;
});

export const ManagerConnectorRepositoryLive = Layer.effect(
  ManagerConnectorRepository,
  makeManagerConnectorRepository,
);
