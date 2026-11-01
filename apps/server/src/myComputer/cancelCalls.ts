/**
 * `notifications/cancelled` for calls that run on the person's computer. MCP
 * clients cancel with that message and keep the POST open, so a stop in the
 * chat wouldn't reach the call by itself (a dropped connection already does).
 * Stopping the call interrupts it: the abort signal sends `kill`.
 *
 * Only `my_computer_*` calls are registered: nothing else here runs for long
 * on someone else's machine.
 *
 * @module myComputer/cancelCalls
 */
import { Deferred, Effect } from "effect";

export interface CancellableCalls {
  /** Run `call`; `cancel(key)` stops it and it answers `whenCancelled`. */
  readonly run: <A, E, R>(
    key: string,
    call: Effect.Effect<A, E, R>,
    whenCancelled: A,
  ) => Effect.Effect<A, E, R>;
  /** Unknown keys are fine: the call may have just ended. */
  readonly cancel: (key: string) => void;
}

export function makeCancellableCalls(): CancellableCalls {
  const running = new Map<string, Deferred.Deferred<void>>();
  return {
    run: (key, call, whenCancelled) =>
      Effect.gen(function* () {
        const stop = yield* Deferred.make<void>();
        running.set(key, stop);
        return yield* Effect.raceFirst(
          call,
          Deferred.await(stop).pipe(Effect.as(whenCancelled)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (running.get(key) === stop) running.delete(key);
            }),
          ),
        );
      }),
    cancel: (key) => {
      const stop = running.get(key);
      if (stop) Effect.runSync(Deferred.succeed(stop, undefined));
    },
  };
}
