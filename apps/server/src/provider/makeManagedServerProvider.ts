import type { ServerProvider } from "@t3tools/contracts";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  PubSub,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import { ServerSettingsError } from "@t3tools/contracts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

// While a provider binary is missing, only every Nth periodic tick actually
// re-probes (e.g. every ~10 minutes at the default 60s interval).
const NOT_INSTALLED_REFRESH_BACKOFF_TICKS = 10;

/**
 * A forced refresh that arrives while the creation probe is still running (or
 * just after it) takes that probe's result instead of starting another one.
 *
 * Every new or rebuilt instance used to be probed twice back to back: its own
 * creation probe below, then the registry's force-refresh of the new instance
 * (ProviderRegistry `syncLiveSources`), queued behind it on the semaphore.
 * For uno-code / OpenCode a probe is `--version` plus a whole `serve`
 * process: seconds of a full processor on a 2 vCPU Work box, twice at boot
 * and twice again when the gateway key lands and the Uno instance is rebuilt.
 */
export const CREATION_PROBE_REUSE_WINDOW = Duration.seconds(2);

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => ServerProvider;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const nextSnapshot = yield* input.checkProvider;
    const nextGeneration = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      return [
        generation,
        {
          snapshot: nextSnapshot,
          enrichmentGeneration: generation,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  // Back off the periodic re-probe while the provider binary is not
  // installed: probing spawns the binary, so a missing harness fails with
  // ENOENT on every tick and turns into permanent log spam on machines that
  // simply don't have it. Settings changes and manual refresh() still probe
  // immediately, so installing the binary is picked up on the next backoff
  // tick at the latest.
  const notInstalledTicksRef = yield* Ref.make(0);
  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const { snapshot } = yield* Ref.get(snapshotStateRef);
          if (!snapshot.installed) {
            const ticks = yield* Ref.updateAndGet(notInstalledTicksRef, (count) => count + 1);
            if (ticks % NOT_INSTALLED_REFRESH_BACKOFF_TICKS !== 0) {
              return;
            }
          } else {
            yield* Ref.set(notInstalledTicksRef, 0);
          }
          yield* refreshSnapshot();
        }),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  const creationProbe = yield* Deferred.make<ServerProvider, ServerSettingsError>();
  const creationProbeDoneAtRef = yield* Ref.make<number | null>(null);
  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.exit,
    Effect.tap(() =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(creationProbeDoneAtRef, now))),
    ),
    Effect.flatMap((exit) => Deferred.done(creationProbe, exit)),
    Effect.flatMap(() => Deferred.await(creationProbe)),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  /** The creation probe's result when it is fresh enough to stand for a refresh. */
  const reuseCreationProbe = Effect.gen(function* () {
    const doneAt = yield* Ref.get(creationProbeDoneAtRef);
    const now = yield* Clock.currentTimeMillis;
    if (
      doneAt !== null &&
      now - doneAt > Duration.toMillis(Duration.fromInputUnsafe(CREATION_PROBE_REUSE_WINDOW))
    ) {
      return null;
    }
    const exit = yield* Effect.exit(Deferred.await(creationProbe));
    return Exit.isSuccess(exit) ? exit.value : null;
  });

  const refreshOrReuseCreationProbe = Effect.gen(function* () {
    const reused = yield* reuseCreationProbe;
    if (reused !== null) return reused;
    return yield* refreshSnapshot();
  });

  return {
    getSnapshot: input.getSettings.pipe(
      Effect.flatMap(applySnapshot),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    refresh: refreshOrReuseCreationProbe.pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
