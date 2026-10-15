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
 * A stream that ends, fails or goes silent past the liveness window is
 * resubscribed with backoff: OpenCode ends `/event` cleanly on instance
 * dispose and the SDK's SSE client does not reconnect after a clean end, so a
 * single subscription silently leaves every session on it deaf. Events
 * published while disconnected are lost (no replay), so subscribers are told
 * through `onStreamLive` once a fresh subscription delivers its first event
 * and can reconcile their state then.
 *
 * Only when consecutive attempts deliver no event at all (the server is gone)
 * is every subscriber of that key told through `onClosed`, off the pump
 * fiber: a subscriber typically tears its session down in response, which may
 * close the very scope the pump runs in.
 *
 * @module sessionEventHub
 */
import { Cause, Clock, Effect, Exit, Fiber, Scope, Stream } from "effect";

/** Liveness window: no event at all for this long means a wedged stream. */
export const SESSION_EVENT_STREAM_IDLE_TIMEOUT_MS = 45_000;
/**
 * Consecutive subscribe attempts that deliver no event at all before the
 * stream is declared dead (~50 s with the backoff below). Any received event
 * resets the counter.
 */
export const SESSION_EVENT_STREAM_MAX_CONSECUTIVE_FAILURES = 12;
const SESSION_EVENT_STREAM_RECONNECT_MIN_MS = 250;
const SESSION_EVENT_STREAM_RECONNECT_MAX_MS = 5_000;

export interface SessionEventStreamDisconnect {
  readonly reason: string;
  readonly attempt: number;
  readonly consecutiveFailures: number;
}

export interface SessionEventSubscriber<Ev> {
  readonly onEvent: (event: Ev) => Effect.Effect<void>;
  readonly onClosed: (detail: string) => Effect.Effect<void>;
  /**
   * Events whose session id matches no subscriber of the stream (e.g. an
   * OpenCode subagent's child session) are offered to every subscriber that
   * sets this, so a subscriber can claim events of sessions it spawned.
   */
  readonly onUnroutedEvent?: (event: Ev) => Effect.Effect<void>;
  /**
   * A fresh subscription delivered its first event: anything published from
   * here on reaches the subscriber, but events from while the stream was down
   * are lost — reconcile state here. Runs before that first event is routed.
   */
  readonly onStreamLive?: () => Effect.Effect<void>;
  /** The stream dropped and is about to be resubscribed. */
  readonly onStreamDisconnected?: (info: SessionEventStreamDisconnect) => Effect.Effect<void>;
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
  /**
   * Liveness window in ms (default {@link SESSION_EVENT_STREAM_IDLE_TIMEOUT_MS}):
   * no event at all for this long aborts the subscription and resubscribes.
   * The producer must send heartbeats more often than this.
   */
  readonly idleTimeoutMs?: number;
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
        // One session's bug must not stop the stream for the others.
        const guard = (effect: Effect.Effect<void>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session-event-hub.subscriber-failed", {
                sessionId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        if (subscriber) return guard(subscriber.onEvent(event));
        const claimants = [...entry.subscribers.values()].filter(
          (candidate) => candidate.onUnroutedEvent !== undefined,
        );
        if (claimants.length === 0) return Effect.void;
        return Effect.forEach(
          claimants,
          (candidate) => guard(candidate.onUnroutedEvent!(event)),
          { discard: true },
        );
      });

    const idleTimeoutMs = options.idleTimeoutMs ?? SESSION_EVENT_STREAM_IDLE_TIMEOUT_MS;
    const watchdogIntervalMs = Math.max(10, Math.min(5_000, idleTimeoutMs / 3));

    const notifySubscribers = (
      entry: StreamEntry<Ev>,
      label: string,
      pick: (subscriber: SessionEventSubscriber<Ev>) => Effect.Effect<void> | undefined,
    ) =>
      Effect.forEach(
        [...entry.subscribers.entries()],
        ([sessionId, subscriber]) => {
          const effect = pick(subscriber);
          return effect === undefined
            ? Effect.void
            : effect.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(label, { sessionId, cause: Cause.pretty(cause) }),
                ),
              );
        },
        { discard: true },
      );

    /**
     * One subscription. Resolves with the reason it ended (stream end,
     * transport error, silence past the liveness window) and how many events
     * it delivered; never fails for transport reasons.
     */
    const runAttempt = (streamKey: string, entry: StreamEntry<Ev>) =>
      Effect.gen(function* () {
        const attemptAbort = new AbortController();
        const abortAttempt = () => attemptAbort.abort();
        entry.abort.signal.addEventListener("abort", abortAttempt);
        let received = 0;
        let dispatching = false;
        let lastEventAt = yield* Clock.currentTimeMillis;
        const consume = Effect.gen(function* () {
          const opened = yield* Effect.exit(options.open(streamKey, attemptAbort.signal));
          if (Exit.isFailure(opened)) {
            return options.describeError(Cause.squash(opened.cause));
          }
          const consumed = yield* Effect.exit(
            Stream.runForEach(opened.value, (event) =>
              Effect.gen(function* () {
                lastEventAt = yield* Clock.currentTimeMillis;
                received += 1;
                dispatching = true;
                if (received === 1) {
                  // The first event proves the subscription is live: from
                  // here on nothing is missed, so a state snapshot taken now
                  // can't miss a later transition.
                  yield* notifySubscribers(
                    entry,
                    "session-event-hub.stream-live-failed",
                    (subscriber) => subscriber.onStreamLive?.(),
                  );
                }
                yield* dispatch(entry, event);
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    dispatching = false;
                    lastEventAt = yield* Clock.currentTimeMillis;
                  }),
                ),
              ),
            ),
          );
          return Exit.isFailure(consumed)
            ? options.describeError(Cause.squash(consumed.cause))
            : "event stream ended";
        });
        // Liveness watchdog: a wedged connection (half-open socket, stalled
        // proxy) never errors, it just stops delivering. A side fiber instead
        // of a per-event timeout keeps the hot delta path cheap.
        const watchdog = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(watchdogIntervalMs);
            if (dispatching) continue;
            if ((yield* Clock.currentTimeMillis) - lastEventAt >= idleTimeoutMs) {
              // Abort first: interrupting the consumer waits for the async
              // iterator to unwind, which only happens once its fetch aborts.
              attemptAbort.abort();
              return `no events for ${idleTimeoutMs} ms (heartbeat missing)`;
            }
          }
        });
        const reason = yield* Effect.raceFirst(consume, watchdog).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.abort.signal.removeEventListener("abort", abortAttempt);
              attemptAbort.abort();
            }),
          ),
        );
        return { reason, received };
      });

    const failStream = (streamKey: string, entry: StreamEntry<Ev>, detail: string) =>
      Effect.suspend(() => {
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
      });

    const startPump = (streamKey: string, entry: StreamEntry<Ev>) =>
      Effect.gen(function* () {
        const isStopping = () => entry.closed || entry.abort.signal.aborted;
        let consecutiveFailures = 0;
        let attempt = 0;
        while (!isStopping()) {
          attempt += 1;
          const result = yield* runAttempt(streamKey, entry);
          if (isStopping()) return;
          consecutiveFailures = result.received > 0 ? 0 : consecutiveFailures + 1;
          const info: SessionEventStreamDisconnect = {
            reason: result.reason,
            attempt,
            consecutiveFailures,
          };
          yield* Effect.logWarning("session-event-hub.stream-disconnected", {
            streamKey,
            ...info,
          });
          if (consecutiveFailures >= SESSION_EVENT_STREAM_MAX_CONSECUTIVE_FAILURES) {
            yield* failStream(streamKey, entry, result.reason);
            return;
          }
          yield* notifySubscribers(
            entry,
            "session-event-hub.stream-disconnected-callback-failed",
            (subscriber) => subscriber.onStreamDisconnected?.(info),
          );
          const backoffMs =
            consecutiveFailures === 0
              ? SESSION_EVENT_STREAM_RECONNECT_MIN_MS
              : Math.min(
                  SESSION_EVENT_STREAM_RECONNECT_MIN_MS * 2 ** consecutiveFailures,
                  SESSION_EVENT_STREAM_RECONNECT_MAX_MS,
                );
          yield* Effect.sleep(backoffMs);
        }
      }).pipe(Effect.forkIn(hubScope));

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
