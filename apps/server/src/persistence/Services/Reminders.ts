/**
 * RemindersRepository - Durable storage for one-shot reminders.
 *
 * A reminder is a `(chatId, message, dueAt)` row. The reminder scheduler sweeps
 * `listDue` on a timer and pushes the message to Telegram; the row is the
 * source of truth, so reminders survive daemon restarts and overdue ones fire
 * on the next sweep after the daemon is back up.
 *
 * @module RemindersRepository
 */
import { Reminder } from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

export const CreateReminderInput = Reminder;
export type CreateReminderInput = typeof CreateReminderInput.Type;

export const ListDueRemindersInput = Schema.Struct({
  now: Schema.String,
  limit: Schema.optional(Schema.Number),
});
export type ListDueRemindersInput = typeof ListDueRemindersInput.Type;

export const ListRemindersInput = Schema.Struct({
  includeInactive: Schema.Boolean,
});
export type ListRemindersInput = typeof ListRemindersInput.Type;

export const GetReminderByIdInput = Schema.Struct({
  reminderId: Schema.String,
});
export type GetReminderByIdInput = typeof GetReminderByIdInput.Type;

export const MarkReminderDeliveredInput = Schema.Struct({
  reminderId: Schema.String,
  deliveredAt: Schema.String,
});
export type MarkReminderDeliveredInput = typeof MarkReminderDeliveredInput.Type;

export const MarkReminderFailedInput = Schema.Struct({
  reminderId: Schema.String,
  failureReason: Schema.String,
});
export type MarkReminderFailedInput = typeof MarkReminderFailedInput.Type;

export const CancelReminderInput = Schema.Struct({
  reminderId: Schema.String,
});
export type CancelReminderInput = typeof CancelReminderInput.Type;

export interface RemindersRepositoryShape {
  readonly create: (input: CreateReminderInput) => Effect.Effect<void, ManagerRepositoryError>;
  /** Pending reminders whose `due_at <= now`, oldest first. */
  readonly listDue: (
    input: ListDueRemindersInput,
  ) => Effect.Effect<ReadonlyArray<Reminder>, ManagerRepositoryError>;
  /** All reminders (optionally only pending), oldest due first. */
  readonly list: (
    input: ListRemindersInput,
  ) => Effect.Effect<ReadonlyArray<Reminder>, ManagerRepositoryError>;
  readonly getById: (
    input: GetReminderByIdInput,
  ) => Effect.Effect<Option.Option<Reminder>, ManagerRepositoryError>;
  /** Conditional pending -> delivered. */
  readonly markDelivered: (
    input: MarkReminderDeliveredInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Conditional pending -> failed. */
  readonly markFailed: (
    input: MarkReminderFailedInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Conditional pending -> cancelled. Returns false if it was not pending. */
  readonly cancel: (
    input: CancelReminderInput,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
}

export class RemindersRepository extends Context.Service<
  RemindersRepository,
  RemindersRepositoryShape
>()("t3/persistence/Services/Reminders/RemindersRepository") {}
