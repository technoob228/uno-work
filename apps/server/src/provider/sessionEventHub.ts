/**
 * One event subscription per stream, fanned out to sessions by session id.
 *
 * A shared OpenCode server publishes the events of every session on the same
 * SSE stream (`/global/event`, or `/event` per directory). Instead of one
 * HTTP subscription per thread — each parsing every other thread's events —
 * the hub opens a stream on the first subscriber of a key, routes each event
 * to the subscriber whose session id it carries, and closes the stream when
 * the last subscriber leaves.
 *
 * When a stream fails (the server died, the SDK gave up reconnecting),
 * every subscriber of that key is told through `onClosed`, off
 * the pump fiber: a subscriber typically tears its session down in response,
 * which may close the very scope the pump runs in.
 *
 * @module sessionEventHub
 */
import { Cause, Effect, Exit, Fiber, Scope, Stream } from "effect";

export interface SessionEventSubscriber<Ev> {
  readonly onEvent: (event: Ev) => Effect.Effect<void>;
  readonly onClosed: (detail: string) => Effect.Effect<void>;
}

export interface SessionEventHub<Ev> {
  /** Returns the unsubscribe effect (idempotent). */
  readonly subscribe: (input: {
    readonly streamKey: string;
    readonly sessionId: string;
    readonly subscriber: SessionEventSubscriber<Ev>;
  }) => Effect.Effect<Effect.Effect<void>>;
  /** Open streams, for tests and diagnostics. */
  readonly openStreams: Effect.Effect<number>;
}

interface StreamEntry<Ev> {
  readonly subscribers: Map<string, SessionEventSubscriber<Ev>>;
  readonly abort: AbortController;
  fiber: Fiber.Fiber<void> | undefined;
  closed: boolean;
}

export interface SessionEventHubOptions<Ev, E> {
  /** Opens the stream for a key; must stop when `signal` aborts. */
  readonly open: (streamKey: string, signal: AbortSignal) => Effect.Effect<Stream.Stream<Ev, E>, E>;
  readonly sessionIdOf: (event: Ev) => string | undefined;
  readonly describeError: (cause: unknown) => string;
  /** Where `onClosed` callbacks run (must outlive the pump's scope). */
  readonly callbackScope: Scope.Scope;
}

export const makeSessionEventHub = <Ev, E>(
  options: SessionEventHubOptions<Ev, E>,
): Effect.Effect<SessionEventHub<Ev>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hubScope = yield* Scope.Scope;
    const streams = new Map<string, StreamEntry<Ev>>();

    const closeStream = (streamKey: string, entry: StreamEntry<Ev>) =>
      Effect.suspend(() => {
        if (entry.closed) return Effect.void;
        entry.closed = true;
        if (streams.get(streamKey) === entry) streams.delete(streamKey);
        entry.abort.abort();
        const fiber = entry.fiber;
        entry.fiber = undefined;
        return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignoreCause) : Effect.void;
      });

    const dispatch = (entry: StreamEntry<Ev>, event: Ev) =>
      Effect.suspend(() => {
        const sessionId = options.sessionIdOf(event);
        const subscriber = sessionId === undefined ? undefined : entry.subscribers.get(sessionId);
        if (!subscriber) return Effect.void;
        // One session's bug must not stop the stream for the others.
        return subscriber.onEvent(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session-event-hub.subscriber-failed", {
              sessionId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      });

    const startPump = (streamKey: string, entry: StreamEntry<Ev>) =>
      Effect.flatMap(options.open(streamKey, entry.abort.signal), (stream) =>
        Stream.runForEach(stream, (event) => dispatch(entry, event)),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.suspend(() => {
            if (entry.closed || entry.abort.signal.aborted) return Effect.void;
            // A clean end is left alone, as before the hub: the SDK's SSE
            // client reconnects by itself and only gives up with an error.
            if (Exit.isSuccess(exit)) return Effect.void;
            const detail = options.describeError(Cause.squash(exit.cause));
            const subscribers = [...entry.subscribers.values()];
            entry.subscribers.clear();
            entry.closed = true;
            if (streams.get(streamKey) === entry) streams.delete(streamKey);
            return Effect.forEach(
              subscribers,
              (subscriber) =>
                subscriber
                  .onClosed(detail)
                  .pipe(Effect.ignoreCause, Effect.forkIn(options.callbackScope)),
              { discard: true },
            );
          }),
        ),
        Effect.forkIn(hubScope),
      );

    const subscribe: SessionEventHub<Ev>["subscribe"] = ({ streamKey, sessionId, subscriber }) =>
      Effect.gen(function* () {
        let entry = streams.get(streamKey);
        if (!entry || entry.closed) {
          const fresh: StreamEntry<Ev> = {
            subscribers: new Map(),
            abort: new AbortController(),
            fiber: undefined,
            closed: false,
          };
          fresh.subscribers.set(sessionId, subscriber);
          streams.set(streamKey, fresh);
          fresh.fiber = yield* startPump(streamKey, fresh);
          entry = fresh;
        } else {
          entry.subscribers.set(sessionId, subscriber);
        }
        const subscribed = entry;
        let done = false;
        // @effect-diagnostics-next-line returnEffectInGen:off
        return Effect.suspend(() => {
          if (done) return Effect.void;
          done = true;
          if (subscribed.subscribers.get(sessionId) === subscriber) {
            subscribed.subscribers.delete(sessionId);
          }
          return subscribed.subscribers.size === 0
            ? closeStream(streamKey, subscribed)
            : Effect.void;
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...streams.entries()], ([key, entry]) => closeStream(key, entry), {
        discard: true,
      }),
    );

    return {
      subscribe,
      openStreams: Effect.sync(() => streams.size),
    } satisfies SessionEventHub<Ev>;
  });
