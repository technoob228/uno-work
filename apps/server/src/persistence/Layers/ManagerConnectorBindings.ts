import {
  ManagerConnectorBindingKind,
  ManagerConnectorBindingTargetKind,
  ProjectId,
  ThreadId,
  type ManagerConnectorBinding,
  type ManagerConnectorBindingTarget,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import {
  ManagerConnectorBindingRepository,
  type ManagerConnectorBindingRepositoryShape,
} from "../Services/ManagerConnectorBindings.ts";

const BindingDbRow = Schema.Struct({
  kind: ManagerConnectorBindingKind,
  chatId: Schema.String,
  connectorProjectId: ProjectId,
  targetKind: ManagerConnectorBindingTargetKind,
  targetId: Schema.String,
  notifyOnComplete: Schema.Number,
  updatedAt: Schema.String,
});
type BindingDbRow = typeof BindingDbRow.Type;

const BindingKeyRequest = Schema.Struct({
  kind: ManagerConnectorBindingKind,
  chatId: Schema.String,
});

const targetFromColumns = (row: BindingDbRow): ManagerConnectorBindingTarget =>
  row.targetKind === "thread"
    ? { kind: "thread", threadId: ThreadId.make(row.targetId) }
    : { kind: row.targetKind, projectId: ProjectId.make(row.targetId) };

const targetToColumns = (
  target: ManagerConnectorBindingTarget,
): { readonly targetKind: ManagerConnectorBinding["target"]["kind"]; readonly targetId: string } =>
  target.kind === "thread"
    ? { targetKind: "thread", targetId: target.threadId }
    : { targetKind: target.kind, targetId: target.projectId };

const toBinding = (row: BindingDbRow): ManagerConnectorBinding => ({
  kind: row.kind,
  chatId: row.chatId,
  connectorProjectId: row.connectorProjectId,
  target: targetFromColumns(row),
  notifyOnComplete: row.notifyOnComplete !== 0,
  updatedAt: row.updatedAt,
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
          `ManagerConnectorBindingRepository.${operation}:query`,
          `ManagerConnectorBindingRepository.${operation}:decode`,
        ),
      ),
    );

const makeManagerConnectorBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: BindingKeyRequest,
    Result: BindingDbRow,
    execute: ({ kind, chatId }) =>
      sql`
        SELECT kind AS "kind", chat_id AS "chatId", connector_project_id AS "connectorProjectId",
               target_kind AS "targetKind", target_id AS "targetId",
               notify_on_complete AS "notifyOnComplete", updated_at AS "updatedAt"
        FROM manager_connector_bindings
        WHERE kind = ${kind} AND chat_id = ${chatId}
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BindingDbRow,
    execute: () =>
      sql`
        SELECT kind AS "kind", chat_id AS "chatId", connector_project_id AS "connectorProjectId",
               target_kind AS "targetKind", target_id AS "targetId",
               notify_on_complete AS "notifyOnComplete", updated_at AS "updatedAt"
        FROM manager_connector_bindings
        ORDER BY kind, chat_id
      `,
  });

  const listRowsByConnectorProject = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: BindingDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT kind AS "kind", chat_id AS "chatId", connector_project_id AS "connectorProjectId",
               target_kind AS "targetKind", target_id AS "targetId",
               notify_on_complete AS "notifyOnComplete", updated_at AS "updatedAt"
        FROM manager_connector_bindings
        WHERE connector_project_id = ${projectId}
        ORDER BY kind, chat_id
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      kind: ManagerConnectorBindingKind,
      chatId: Schema.String,
      connectorProjectId: ProjectId,
      targetKind: ManagerConnectorBindingTargetKind,
      targetId: Schema.String,
      notifyOnComplete: Schema.Number,
      updatedAt: Schema.String,
    }),
    execute: ({
      kind,
      chatId,
      connectorProjectId,
      targetKind,
      targetId,
      notifyOnComplete,
      updatedAt,
    }) =>
      sql`
        INSERT INTO manager_connector_bindings
          (kind, chat_id, connector_project_id, target_kind, target_id, notify_on_complete, updated_at)
        VALUES (${kind}, ${chatId}, ${connectorProjectId}, ${targetKind}, ${targetId}, ${notifyOnComplete}, ${updatedAt})
        ON CONFLICT(kind, chat_id) DO UPDATE SET
          connector_project_id = excluded.connector_project_id,
          target_kind = excluded.target_kind,
          target_id = excluded.target_id,
          notify_on_complete = excluded.notify_on_complete,
          updated_at = excluded.updated_at
      `,
  });

  const deleteRow = SqlSchema.findAll({
    Request: BindingKeyRequest,
    Result: Schema.Struct({ chatId: Schema.String }),
    execute: ({ kind, chatId }) =>
      sql`
        DELETE FROM manager_connector_bindings
        WHERE kind = ${kind} AND chat_id = ${chatId}
        RETURNING chat_id AS "chatId"
      `,
  });

  const get: ManagerConnectorBindingRepositoryShape["get"] = (input) =>
    getRow(input).pipe(withRepositoryError("get"), Effect.map(Option.map(toBinding)));

  const listAll: ManagerConnectorBindingRepositoryShape["listAll"] = () =>
    listAllRows().pipe(
      withRepositoryError("listAll"),
      Effect.map((rows) => rows.map(toBinding)),
    );

  const listByConnectorProject: ManagerConnectorBindingRepositoryShape["listByConnectorProject"] = (
    projectId,
  ) =>
    listRowsByConnectorProject({ projectId }).pipe(
      withRepositoryError("listByConnectorProject"),
      Effect.map((rows) => rows.map(toBinding)),
    );

  const upsert: ManagerConnectorBindingRepositoryShape["upsert"] = (input) =>
    upsertRow({
      kind: input.kind,
      chatId: input.chatId,
      connectorProjectId: input.connectorProjectId,
      ...targetToColumns(input.target),
      notifyOnComplete: input.notifyOnComplete ? 1 : 0,
      updatedAt: input.updatedAt,
    }).pipe(withRepositoryError("upsert"));

  const remove: ManagerConnectorBindingRepositoryShape["remove"] = (input) =>
    deleteRow(input).pipe(
      withRepositoryError("remove"),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    get,
    listAll,
    listByConnectorProject,
    upsert,
    remove,
  } satisfies ManagerConnectorBindingRepositoryShape;
});

export const ManagerConnectorBindingRepositoryLive = Layer.effect(
  ManagerConnectorBindingRepository,
  makeManagerConnectorBindingRepository,
);
