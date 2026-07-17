import { ProjectId, Reminder, ReminderConnectorKind, ReminderStatus } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import {
  CancelReminderInput,
  CreateReminderInput,
  GetReminderByIdInput,
  ListDueRemindersInput,
  ListRemindersInput,
  MarkReminderDeliveredInput,
  MarkReminderFailedInput,
  RemindersRepository,
  type RemindersRepositoryShape,
} from "../Services/Reminders.ts";

const ReminderDbRow = Schema.Struct({
  reminderId: Schema.String,
  projectId: ProjectId,
  chatId: Schema.String,
  connector: ReminderConnectorKind,
  message: Schema.String,
  dueAt: Schema.String,
  status: ReminderStatus,
  createdAt: Schema.String,
  createdBy: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.String),
});

function toReminder(row: typeof ReminderDbRow.Type): Reminder {
  return {
    reminderId: row.reminderId,
    projectId: row.projectId,
    chatId: row.chatId,
    connector: row.connector,
    message: row.message,
    dueAt: row.dueAt,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    deliveredAt: row.deliveredAt,
    failureReason: row.failureReason,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ManagerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const DEFAULT_DUE_LIMIT = 50;

const makeRemindersRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createRow = SqlSchema.void({
    Request: CreateReminderInput,
    execute: (input) =>
      sql`
        INSERT INTO reminders (
          reminder_id,
          project_id,
          chat_id,
          connector,
          message,
          due_at,
          status,
          created_at,
          created_by,
          delivered_at,
          failure_reason
        )
        VALUES (
          ${input.reminderId},
          ${input.projectId},
          ${input.chatId},
          ${input.connector},
          ${input.message},
          ${input.dueAt},
          ${input.status},
          ${input.createdAt},
          ${input.createdBy},
          ${input.deliveredAt},
          ${input.failureReason}
        )
      `,
  });

  const listDueRows = SqlSchema.findAll({
    Request: ListDueRemindersInput,
    Result: ReminderDbRow,
    execute: ({ now, limit }) =>
      sql`
        SELECT
          reminder_id AS "reminderId",
          project_id AS "projectId",
          chat_id AS "chatId",
          connector AS "connector",
          message AS "message",
          due_at AS "dueAt",
          status AS "status",
          created_at AS "createdAt",
          created_by AS "createdBy",
          delivered_at AS "deliveredAt",
          failure_reason AS "failureReason"
        FROM reminders
        WHERE status = 'pending'
          AND due_at <= ${now}
        ORDER BY due_at ASC, reminder_id ASC
        LIMIT ${limit ?? DEFAULT_DUE_LIMIT}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListRemindersInput,
    Result: ReminderDbRow,
    execute: ({ includeInactive }) =>
      sql`
        SELECT
          reminder_id AS "reminderId",
          project_id AS "projectId",
          chat_id AS "chatId",
          connector AS "connector",
          message AS "message",
          due_at AS "dueAt",
          status AS "status",
          created_at AS "createdAt",
          created_by AS "createdBy",
          delivered_at AS "deliveredAt",
          failure_reason AS "failureReason"
        FROM reminders
        WHERE (${includeInactive ? 1 : 0} = 1 OR status = 'pending')
        ORDER BY due_at ASC, reminder_id ASC
      `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: GetReminderByIdInput,
    Result: ReminderDbRow,
    execute: ({ reminderId }) =>
      sql`
        SELECT
          reminder_id AS "reminderId",
          project_id AS "projectId",
          chat_id AS "chatId",
          connector AS "connector",
          message AS "message",
          due_at AS "dueAt",
          status AS "status",
          created_at AS "createdAt",
          created_by AS "createdBy",
          delivered_at AS "deliveredAt",
          failure_reason AS "failureReason"
        FROM reminders
        WHERE reminder_id = ${reminderId}
      `,
  });

  const markDeliveredRow = SqlSchema.void({
    Request: MarkReminderDeliveredInput,
    execute: ({ reminderId, deliveredAt }) =>
      sql`
        UPDATE reminders
        SET status = 'delivered',
            delivered_at = ${deliveredAt}
        WHERE reminder_id = ${reminderId}
          AND status = 'pending'
      `,
  });

  const markFailedRow = SqlSchema.void({
    Request: MarkReminderFailedInput,
    execute: ({ reminderId, failureReason }) =>
      sql`
        UPDATE reminders
        SET status = 'failed',
            failure_reason = ${failureReason}
        WHERE reminder_id = ${reminderId}
          AND status = 'pending'
      `,
  });

  const cancelRows = SqlSchema.findAll({
    Request: CancelReminderInput,
    Result: Schema.Struct({ reminderId: Schema.String }),
    execute: ({ reminderId }) =>
      sql`
        UPDATE reminders
        SET status = 'cancelled'
        WHERE reminder_id = ${reminderId}
          AND status = 'pending'
        RETURNING reminder_id AS "reminderId"
      `,
  });

  const create: RemindersRepositoryShape["create"] = (input) =>
    createRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.create:query",
          "RemindersRepository.create:encodeRequest",
        ),
      ),
    );

  const listDue: RemindersRepositoryShape["listDue"] = (input) =>
    listDueRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.listDue:query",
          "RemindersRepository.listDue:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toReminder)),
    );

  const list: RemindersRepositoryShape["list"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.list:query",
          "RemindersRepository.list:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toReminder)),
    );

  const getById: RemindersRepositoryShape["getById"] = (input) =>
    getRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.getById:query",
          "RemindersRepository.getById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toReminder)),
    );

  const markDelivered: RemindersRepositoryShape["markDelivered"] = (input) =>
    markDeliveredRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.markDelivered:query",
          "RemindersRepository.markDelivered:encodeRequest",
        ),
      ),
    );

  const markFailed: RemindersRepositoryShape["markFailed"] = (input) =>
    markFailedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.markFailed:query",
          "RemindersRepository.markFailed:encodeRequest",
        ),
      ),
    );

  const cancel: RemindersRepositoryShape["cancel"] = (input) =>
    cancelRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "RemindersRepository.cancel:query",
          "RemindersRepository.cancel:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    create,
    listDue,
    list,
    getById,
    markDelivered,
    markFailed,
    cancel,
  } satisfies RemindersRepositoryShape;
});

export const RemindersRepositoryLive = Layer.effect(RemindersRepository, makeRemindersRepository);
