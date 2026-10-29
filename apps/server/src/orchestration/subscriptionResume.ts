/**
 * Subscription resume for `orchestration.subscribeShell` / `subscribeThread`.
 *
 * A client on a bad link reconnects often. Without resume every reconnect
 * re-sent the whole shell (every project and chat) and, for each chat the
 * client keeps warm, the full history. With resume the client sends the last
 * sequence it applied and gets only what changed after it:
 *
 *  - shell: one upsert/remove per project or chat touched in the gap, built
 *    from the current projection (the same thing the live stream would have
 *    sent last for that aggregate);
 *  - thread: the chat's own detail events in the gap, streaming deltas folded
 *    into one event per message.
 *
 * Both end with a `resumed` marker. A full snapshot is used instead when the
 * cursor is unknown (ahead of this server, e.g. a reset database) or the gap is
 * too large to be cheaper than a snapshot.
 *
 * Ordering/duplication: the live subscription is opened *before* the gap is
 * read (`subscribeNow`), and live events at or below the last replayed
 * sequence are dropped, so nothing committed during the read is lost and
 * nothing is sent twice.
 */
import type {
  OrchestrationEvent,
  OrchestrationShellStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import { coalesceOrchestrationMessageDeltas } from "@t3tools/shared/orchestrationEvents";
import { Effect, Option, Queue, Stream } from "effect";
import type { Cause, Scope } from "effect";

/** Gap (raw events, all aggregates) above which the shell resyncs from a snapshot. */
export const SHELL_RESUME_MAX_EVENTS = 5_000;
/** Gap (raw events of one chat) above which a chat resyncs from a snapshot. */
export const THREAD_RESUME_MAX_EVENTS = 5_000;
/** Folded events of one chat above which a snapshot is the cheaper resync. */
export const THREAD_RESUME_MAX_ITEMS = 400;

export type ResumeFallbackReason = "no-cursor" | "cursor-ahead" | "gap-too-large" | "not-found";

export type ResumePlan<T> =
  | {
      readonly kind: "replay";
      readonly items: ReadonlyArray<T>;
      /** Highest sequence covered by the replay; live events must be above it. */
      readonly lastSequence: number;
    }
  | { readonly kind: "snapshot"; readonly reason: ResumeFallbackReason };

/**
 * Starts consuming a hot stream right now and buffers what it emits until the
 * returned stream is pulled. Lets a handler open the live subscription before
 * it reads history, so events committed in between are not lost.
 */
export const subscribeNow = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<Stream.Stream<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A, E | Cause.Done>();
    // startImmediately: the fork runs synchronously up to its first suspension,
    // which is after the PubSub subscription is taken.
    yield* Stream.runIntoQueue(stream, queue).pipe(Effect.forkScoped({ startImmediately: true }));
    return Stream.fromQueue(queue);
  });

/**
 * The newest event of every aggregate in `events`, ordered by that event's
 * sequence. A shell event is computed from the projection's current state, so
 * only the last event per aggregate matters for the end result.
 */
export function latestEventPerAggregate(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  const latest = new Map<string, OrchestrationEvent>();
  for (const event of events) {
    const key = `${event.aggregateKind}:${event.aggregateId}`;
    const previous = latest.get(key);
    if (previous === undefined || event.sequence > previous.sequence) {
      latest.set(key, event);
    }
  }
  return [...latest.values()].toSorted((left, right) => left.sequence - right.sequence);
}

const readGap = <E>(
  cursor: number,
  maxEvents: number,
  read: (cursor: number, limit: number) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, E>,
): Effect.Effect<Option.Option<ReadonlyArray<OrchestrationEvent>>, E> =>
  read(cursor, maxEvents + 1).pipe(
    Effect.map((events) => (events.length > maxEvents ? Option.none() : Option.some(events))),
  );

export const planShellResume = <E>(input: {
  readonly cursor: number | undefined;
  readonly currentSequence: number;
  readonly readEvents: (
    cursor: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, E>;
  readonly toShellEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<Option.Option<OrchestrationShellStreamEvent>>;
  readonly maxEvents?: number;
}): Effect.Effect<ResumePlan<OrchestrationShellStreamEvent>, E> =>
  Effect.gen(function* () {
    const cursor = input.cursor;
    if (cursor === undefined || cursor <= 0) {
      return { kind: "snapshot", reason: "no-cursor" } as const;
    }
    if (cursor > input.currentSequence) {
      return { kind: "snapshot", reason: "cursor-ahead" } as const;
    }
    const gap = yield* readGap(
      cursor,
      input.maxEvents ?? SHELL_RESUME_MAX_EVENTS,
      input.readEvents,
    );
    if (Option.isNone(gap)) {
      return { kind: "snapshot", reason: "gap-too-large" } as const;
    }
    const items: OrchestrationShellStreamEvent[] = [];
    for (const event of latestEventPerAggregate(gap.value)) {
      const shellEvent = yield* input.toShellEvent(event);
      if (Option.isSome(shellEvent)) {
        items.push(shellEvent.value);
      }
    }
    return {
      kind: "replay",
      items,
      lastSequence: Math.max(cursor, gap.value.at(-1)?.sequence ?? cursor),
    } as const;
  });

export const planThreadResume = <E>(input: {
  readonly threadId: ThreadId;
  readonly cursor: number | undefined;
  readonly currentSequence: number;
  readonly threadExists: Effect.Effect<boolean, E>;
  readonly readThreadEvents: (
    cursor: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, E>;
  readonly isDetailEvent: (event: OrchestrationEvent) => boolean;
  readonly maxEvents?: number;
  readonly maxItems?: number;
}): Effect.Effect<ResumePlan<OrchestrationEvent>, E> =>
  Effect.gen(function* () {
    const cursor = input.cursor;
    if (cursor === undefined || cursor <= 0) {
      return { kind: "snapshot", reason: "no-cursor" } as const;
    }
    if (cursor > input.currentSequence) {
      return { kind: "snapshot", reason: "cursor-ahead" } as const;
    }
    if (!(yield* input.threadExists)) {
      // The snapshot path reports the missing chat the way it always has.
      return { kind: "snapshot", reason: "not-found" } as const;
    }
    const gap = yield* readGap(
      cursor,
      input.maxEvents ?? THREAD_RESUME_MAX_EVENTS,
      input.readThreadEvents,
    );
    if (Option.isNone(gap)) {
      return { kind: "snapshot", reason: "gap-too-large" } as const;
    }
    const items = coalesceOrchestrationMessageDeltas(
      gap.value.filter(
        (event) =>
          event.aggregateKind === "thread" &&
          event.aggregateId === input.threadId &&
          input.isDetailEvent(event),
      ),
    );
    if (items.length > (input.maxItems ?? THREAD_RESUME_MAX_ITEMS)) {
      return { kind: "snapshot", reason: "gap-too-large" } as const;
    }
    return {
      kind: "replay",
      items,
      lastSequence: Math.max(cursor, gap.value.at(-1)?.sequence ?? cursor),
    } as const;
  });

/** Live events strictly after `sequence` (drops what the replay/snapshot already covered). */
export const liveAfter = <E>(
  live: Stream.Stream<OrchestrationEvent, E>,
  sequence: number,
): Stream.Stream<OrchestrationEvent, E> =>
  live.pipe(Stream.filter((event) => event.sequence > sequence));
