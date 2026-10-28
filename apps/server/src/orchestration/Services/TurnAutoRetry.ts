/**
 * TurnAutoRetry - continues a turn that failed for a reason that is not the
 * person's problem ("Uno AI is busy", "Uno AI didn't answer"), without them.
 *
 * The product promise is "close your laptop, the agent keeps working": a
 * single gateway timeout used to end a long task with "Failed" until the
 * person came back (customer walkthrough 25.10.2026). The decision (which
 * errors, how long to wait, how many times) is the pure
 * `decideTurnAutoRetry` of `@t3tools/shared/turnErrorRetry`, shared with the
 * client so both agree on what "busy" and "didn't answer" are.
 *
 * @module TurnAutoRetry
 */
import { Context } from "effect";
import type { ThreadId } from "@t3tools/contracts";
import type { TurnAutoRetryDecision } from "@t3tools/shared/turnErrorRetry";
import type { Effect, Scope } from "effect";

/** Command ids of the continuations this service sends (`thread.turn.start`). */
export const TURN_AUTO_RETRY_COMMAND_PREFIX = "turn-auto-retry:";
/** `systemCommandOrigin` component of those continuations. */
export const TURN_AUTO_RETRY_ORIGIN_COMPONENT = "turn-auto-retry";

export interface TurnAutoRetryShape {
  /**
   * A turn of the thread failed with `error`. Schedules the continuation when
   * `decideTurnAutoRetry` allows (the caller then keeps the thread "working"
   * instead of showing the error) and returns the decision. A second failure
   * report while a continuation is already waiting returns that one again.
   */
  readonly onTurnFailed: (input: {
    readonly threadId: ThreadId;
    readonly error: string;
  }) => Effect.Effect<TurnAutoRetryDecision>;

  /** A turn of the thread finished well: the chain is over, the counter resets. */
  readonly onTurnSucceeded: (threadId: ThreadId) => Effect.Effect<void>;

  /** A continuation is waiting to be sent for the thread. */
  readonly isPending: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Start watching domain events that call a waiting continuation off: the
   * person (or anyone else) starting a turn, Stop, the session stopping, the
   * chat being deleted. Must run in a scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class TurnAutoRetry extends Context.Service<TurnAutoRetry, TurnAutoRetryShape>()(
  "t3/orchestration/Services/TurnAutoRetry",
) {}
