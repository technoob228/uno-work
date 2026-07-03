import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import {
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

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ManagerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeManagerConnectorRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, kind: ManagerConnectorKind }),
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

  const get: ManagerConnectorRepositoryShape["get"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerConnectorRepository.get:query",
          "ManagerConnectorRepository.get:decodeRow",
        ),
      ),
    );

  const listByKind: ManagerConnectorRepositoryShape["listByKind"] = (kind) =>
    listRowsByKind({ kind }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerConnectorRepository.listByKind:query",
          "ManagerConnectorRepository.listByKind:decodeRows",
        ),
      ),
    );

  const upsert: ManagerConnectorRepositoryShape["upsert"] = ({
    projectId,
    kind,
    config,
    updatedAt,
  }) =>
    upsertRow({ projectId, kind, configJson: JSON.stringify(config), updatedAt }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerConnectorRepository.upsert:query",
          "ManagerConnectorRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getThreadForChat: ManagerConnectorRepositoryShape["getThreadForChat"] = (input) =>
    getThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerConnectorRepository.getThreadForChat:query",
          "ManagerConnectorRepository.getThreadForChat:decodeRow",
        ),
      ),
      Effect.map(Option.map((row) => row.threadId)),
    );

  const setThreadForChat: ManagerConnectorRepositoryShape["setThreadForChat"] = (input) =>
    setThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerConnectorRepository.setThreadForChat:query",
          "ManagerConnectorRepository.setThreadForChat:encodeRequest",
        ),
      ),
    );

  return {
    get,
    listByKind,
    upsert,
    getThreadForChat,
    setThreadForChat,
  } satisfies ManagerConnectorRepositoryShape;
});

export const ManagerConnectorRepositoryLive = Layer.effect(
  ManagerConnectorRepository,
  makeManagerConnectorRepository,
);
