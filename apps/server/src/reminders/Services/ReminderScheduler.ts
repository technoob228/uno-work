import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ReminderSchedulerShape {
  /**
   * Start the background reminder sweep within the provided scope. Each tick
   * pulls due reminders and delivers them to Telegram.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ReminderScheduler extends Context.Service<
  ReminderScheduler,
  ReminderSchedulerShape
>()("t3/reminders/Services/ReminderScheduler") {}
