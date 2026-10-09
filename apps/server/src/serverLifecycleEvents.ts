import type {
  ExecutionEnvironmentDescriptor,
  ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Context, Stream } from "effect";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export interface ServerLifecycleEventsShape {
  readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
  readonly snapshot: Effect.Effect<SnapshotState>;
  readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  ServerLifecycleEventsShape
>()("t3/serverLifecycleEvents") {}

export const ServerLifecycleEventsLive = Layer.effect(
  ServerLifecycleEvents,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
    const state = yield* Ref.make<SnapshotState>({
      sequence: 0,
      events: [],
    });

    return {
      publish: (event) =>
        Ref.modify(state, (current) => {
          const nextSequence = current.sequence + 1;
          const nextEvent = {
            ...event,
            sequence: nextSequence,
          } satisfies ServerLifecycleStreamEvent;
          const nextEvents =
            nextEvent.type === "welcome"
              ? [nextEvent, ...current.events.filter((entry) => entry.type !== "welcome")]
              : [nextEvent, ...current.events.filter((entry) => entry.type !== "ready")];
          return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
        }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event))),
      snapshot: Ref.get(state),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies ServerLifecycleEventsShape;
  }),
);

/**
 * A remembered lifecycle event, replayed to a new subscriber with the
 * environment as it is NOW.
 *
 * "welcome" and "ready" are published once at startup. On a Work machine
 * cloned from an image's memory snapshot that startup happened on the warm-up
 * VM: the events carry its environment id ("Uno computer", machineKind
 * "server"), and the clone rotates the id afterwards (cloneIdentity.ts). The
 * browser checks that every source names the same environment
 * (environments/runtime/connection.ts), so the stale welcome made it drop the
 * connection — "Connecting…", Files "Environment API not found", New project
 * "Looking for your home folder…" on every fresh computer until the daemon
 * restarted (icp3 09.10).
 */
export function withCurrentEnvironment(
  event: ServerLifecycleStreamEvent,
  environment: ExecutionEnvironmentDescriptor,
): ServerLifecycleStreamEvent {
  return event.type === "welcome"
    ? { ...event, payload: { ...event.payload, environment } }
    : { ...event, payload: { ...event.payload, environment } };
}
