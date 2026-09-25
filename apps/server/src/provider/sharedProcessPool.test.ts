import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";

import { makeSharedProcessPool } from "./sharedProcessPool.ts";

interface FakeProcess {
  readonly id: number;
  readonly exited: Deferred.Deferred<number>;
}

const makeHarness = () =>
  Effect.sync(() => {
    const state = { started: 0, closed: [] as number[] };
    const start = Effect.gen(function* () {
      state.started += 1;
      const id = state.started;
      yield* Effect.addFinalizer(() => Effect.sync(() => state.closed.push(id)));
      return { id, exited: yield* Deferred.make<number>() } satisfies FakeProcess;
    });
    return { state, start };
  });

it.effect("shares one resource per key and closes it when the last lease is released", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pool = yield* makeSharedProcessPool<string, FakeProcess, never>().pipe(
      Scope.provide(scope),
    );
    const { state, start } = yield* makeHarness();

    const a = yield* pool.acquire("k", start);
    const b = yield* pool.acquire("k", start);
    const c = yield* pool.acquire("other", start);
    assert.equal(state.started, 2);
    assert.equal(a.value.id, b.value.id);
    assert.notEqual(a.value.id, c.value.id);
    assert.equal(yield* pool.refCount("k"), 2);

    yield* a.release;
    yield* a.release; // idempotent
    assert.equal(yield* pool.refCount("k"), 1);
    assert.deepEqual(state.closed, []);

    yield* b.release;
    assert.deepEqual(state.closed, [a.value.id]);
    assert.equal(yield* pool.size, 1);

    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(state.closed, [a.value.id, c.value.id]);
  }),
);

it.effect("keeps an unused resource for the linger window and reuses it", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pool = yield* makeSharedProcessPool<string, FakeProcess, never>({
      lingerMs: 10_000,
    }).pipe(Scope.provide(scope));
    const { state, start } = yield* makeHarness();

    const first = yield* pool.acquire("k", start);
    yield* first.release;
    yield* TestClock.adjust(5_000);
    assert.deepEqual(state.closed, []);

    const second = yield* pool.acquire("k", start);
    assert.equal(state.started, 1, "reused inside the linger window");
    yield* second.release;
    yield* Effect.yieldNow; // let the linger fiber start sleeping
    yield* TestClock.adjust(10_001);
    yield* Effect.yieldNow;
    assert.deepEqual(state.closed, [first.value.id]);
    assert.equal(yield* pool.size, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("drops a resource that died on its own; the next acquire starts a fresh one", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pool = yield* makeSharedProcessPool<string, FakeProcess, never>({
      awaitExit: (process) => Deferred.await(process.exited),
    }).pipe(Scope.provide(scope));
    const { state, start } = yield* makeHarness();

    const holder = yield* pool.acquire("k", start);
    yield* Deferred.succeed(holder.value.exited, 1);
    yield* Effect.yieldNow;
    assert.equal(yield* pool.size, 0);

    const next = yield* pool.acquire("k", start);
    assert.equal(state.started, 2);
    assert.notEqual(next.value.id, holder.value.id);

    // The old holder's release still cleans up the dead entry's scope.
    yield* holder.release;
    assert.deepEqual(state.closed, [holder.value.id]);
    assert.equal(yield* pool.refCount("k"), 1);
    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(state.closed, [holder.value.id, next.value.id]);
  }),
);

it.effect("concurrent acquires during a slow start share the same start", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pool = yield* makeSharedProcessPool<string, number, never>().pipe(Scope.provide(scope));
    const gate = yield* Deferred.make<void>();
    let starts = 0;
    const start = Effect.gen(function* () {
      starts += 1;
      yield* Deferred.await(gate);
      return 42;
    });
    const first = yield* pool.acquire("k", start).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const second = yield* pool.acquire("k", start).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, undefined);
    const a = yield* Fiber.join(first);
    const b = yield* Fiber.join(second);
    assert.equal(starts, 1);
    assert.equal(a.value, 42);
    assert.equal(b.value, 42);
    assert.equal(yield* pool.refCount("k"), 2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("a failed start is not cached and fails every waiter", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const pool = yield* makeSharedProcessPool<string, number, string>().pipe(Scope.provide(scope));
    let attempts = 0;
    const failing = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail("boom");
    });
    const exit = yield* Effect.exit(pool.acquire("k", failing));
    assert.ok(Exit.isFailure(exit));
    assert.equal(yield* pool.size, 0);

    const lease = yield* pool.acquire("k", Effect.succeed(7));
    assert.equal(lease.value, 7);
    assert.equal(attempts, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);
