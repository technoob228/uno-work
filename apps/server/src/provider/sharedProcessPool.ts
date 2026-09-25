/**
 * A keyed, ref-counted pool of long-lived resources (harness server
 * processes). The first `acquire` of a key starts the resource in its own
 * scope; later acquires of the same key share it; the scope closes (killing
 * the process) when the last lease is released — optionally after a short
 * linger, so a thread that restarts its session (runtime mode change, resume)
 * doesn't pay for a fresh process.
 *
 * A resource can die on its own (`awaitExit` resolves). The entry is then
 * dropped at once, so the next `acquire` starts a fresh one while the holders
 * of the dead one learn about it through their own exit watchers and release
 * their leases as usual.
 *
 * @module sharedProcessPool
 */
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

export interface PoolLease<R> {
  readonly value: R;
  /** Idempotent. */
  readonly release: Effect.Effect<void>;
}

export interface SharedProcessPool<K, R, E> {
  readonly acquire: (
    key: K,
    start: Effect.Effect<R, E, Scope.Scope>,
  ) => Effect.Effect<PoolLease<R>, E>;
  /** Live entries (starting or started), for tests and diagnostics. */
  readonly size: Effect.Effect<number>;
  readonly refCount: (key: K) => Effect.Effect<number>;
  /** Closes every entry. Safe to call more than once. */
  readonly shutdown: Effect.Effect<void>;
}

interface Entry<R, E> {
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<R, E>;
  refs: number;
  closed: boolean;
  linger: Fiber.Fiber<void> | undefined;
}

export interface SharedProcessPoolOptions<R> {
  /** Keep an unused resource this long before closing it (0 = close at once). */
  readonly lingerMs?: number;
  /** Resolves when the resource dies on its own. */
  readonly awaitExit?: (value: R) => Effect.Effect<unknown>;
}

export const makeSharedProcessPool = <K, R, E>(
  options?: SharedProcessPoolOptions<R>,
): Effect.Effect<SharedProcessPool<K, R, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lingerMs = Math.max(0, options?.lingerMs ?? 0);
    const poolScope = yield* Scope.Scope;
    const entries = new Map<K, Entry<R, E>>();

    const closeEntry = (key: K, entry: Entry<R, E>) =>
      Effect.suspend(() => {
        if (entry.closed) return Effect.void;
        entry.closed = true;
        if (entries.get(key) === entry) entries.delete(key);
        const linger = entry.linger;
        entry.linger = undefined;
        return (linger ? Fiber.interrupt(linger) : Effect.void).pipe(
          Effect.andThen(Scope.close(entry.scope, Exit.void)),
          Effect.ignoreCause,
        );
      });

    const releaseOnce = (key: K, entry: Entry<R, E>) => {
      let released = false;
      return Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        entry.refs -= 1;
        if (entry.refs > 0 || entry.closed) return Effect.void;
        if (lingerMs === 0 || entries.get(key) !== entry) return closeEntry(key, entry);
        return Effect.sleep(lingerMs).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (entry.refs !== 0) return Effect.void;
              // This fiber is the linger: detach it first, or closeEntry
              // would interrupt itself before closing the scope.
              entry.linger = undefined;
              return closeEntry(key, entry);
            }),
          ),
          Effect.forkIn(poolScope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              entry.linger = fiber;
            }),
          ),
          Effect.asVoid,
        );
      });
    };

    const acquire: SharedProcessPool<K, R, E>["acquire"] = (key, start) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = entries.get(key);
          if (existing && !existing.closed) {
            existing.refs += 1;
            const linger = existing.linger;
            existing.linger = undefined;
            if (linger) yield* Fiber.interrupt(linger);
            const value = yield* restore(Deferred.await(existing.ready)).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? releaseOnce(key, existing) : Effect.void,
              ),
            );
            return { value, release: releaseOnce(key, existing) } satisfies PoolLease<R>;
          }

          const entry: Entry<R, E> = {
            scope: yield* Scope.fork(poolScope),
            ready: yield* Deferred.make<R, E>(),
            refs: 1,
            closed: false,
            linger: undefined,
          };
          entries.set(key, entry);
          const started = yield* Effect.exit(restore(start).pipe(Scope.provide(entry.scope)));
          yield* Deferred.done(entry.ready, started);
          if (Exit.isFailure(started)) {
            entry.refs = 0;
            yield* closeEntry(key, entry);
            return yield* Effect.failCause(started.cause);
          }
          const value = started.value;
          if (options?.awaitExit) {
            // Forked into the entry's own scope: closing the entry interrupts
            // the watcher, so only a death on its own drops the entry here.
            yield* options.awaitExit(value).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (entries.get(key) === entry) entries.delete(key);
                }),
              ),
              Effect.ignoreCause,
              Effect.forkIn(entry.scope),
            );
          }
          return { value, release: releaseOnce(key, entry) } satisfies PoolLease<R>;
        }),
      );

    const shutdown = Effect.suspend(() =>
      Effect.forEach([...entries.entries()], ([key, entry]) => closeEntry(key, entry), {
        discard: true,
      }),
    );
    yield* Effect.addFinalizer(() => shutdown);

    return {
      acquire,
      size: Effect.sync(() => entries.size),
      refCount: (key) => Effect.sync(() => entries.get(key)?.refs ?? 0),
      shutdown,
    } satisfies SharedProcessPool<K, R, E>;
  });
