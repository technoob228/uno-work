import { Duration, Effect, Layer, Schedule } from "effect";

import { ManagerTelegramService } from "../../manager/Layers/TelegramConnector.ts";
import { RemindersRepository } from "../../persistence/Services/Reminders.ts";
import {
  ReminderScheduler,
  type ReminderSchedulerShape,
} from "../Services/ReminderScheduler.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;
const DEFAULT_BATCH_SIZE = 50;

export interface ReminderSchedulerLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly batchSize?: number;
}

const makeReminderScheduler = (options?: ReminderSchedulerLiveOptions) =>
  Effect.gen(function* () {
    const reminders = yield* RemindersRepository;
    const telegram = yield* ManagerTelegramService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BATCH_SIZE);

    const sweep = Effect.gen(function* () {
      const now = new Date().toISOString();
      const due = yield* reminders.listDue({ now, limit: batchSize });
      if (due.length === 0) {
        return;
      }
      for (const reminder of due) {
        const text = `⏰ Напоминание: ${reminder.message}`;
        const delivered = yield* telegram.sendText({
          projectId: reminder.projectId,
          chatId: reminder.chatId,
          text,
        });
        if (delivered) {
          yield* reminders.markDelivered({
            reminderId: reminder.reminderId,
            deliveredAt: new Date().toISOString(),
          });
          yield* Effect.logInfo("reminder.delivered", {
            reminderId: reminder.reminderId,
            chatId: reminder.chatId,
          });
        } else {
          yield* reminders.markFailed({
            reminderId: reminder.reminderId,
            failureReason: "telegram delivery failed",
          });
          yield* Effect.logWarning("reminder.delivery-failed", {
            reminderId: reminder.reminderId,
            chatId: reminder.chatId,
          });
        }
      }
    });

    const start: ReminderSchedulerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("reminder.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("reminder.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("reminder.scheduler.started", { sweepIntervalMs, batchSize });
      });

    return { start } satisfies ReminderSchedulerShape;
  });

export const makeReminderSchedulerLive = (options?: ReminderSchedulerLiveOptions) =>
  Layer.effect(ReminderScheduler, makeReminderScheduler(options));

export const ReminderSchedulerLive = makeReminderSchedulerLive();
