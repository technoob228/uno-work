import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { warmStatusRouteLayer, WARM_STATUS_PATH } from "./warmStatus.ts";

const makeFixture = Effect.gen(function* () {
  const probes = yield* Deferred.make<void>();
  const registry = Layer.succeed(ProviderRegistry, {
    awaitBootProbes: Deferred.await(probes),
  } as unknown as ProviderRegistry["Service"]);
  const context = yield* Layer.build(registry);
  const { handler, dispose } = HttpRouter.toWebHandler(warmStatusRouteLayer, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  const get = Effect.promise(async () => {
    const res = await handler(new Request(`http://127.0.0.1${WARM_STATUS_PATH}`), context);
    return { status: res.status, body: (await res.json()) as { warm: boolean } };
  });
  return { get, finishProbes: Deferred.succeed(probes, undefined) };
});

it.effect("answers 503 until the boot probes finish, then 200", () =>
  Effect.gen(function* () {
    const { get, finishProbes } = yield* makeFixture;
    const cold = yield* get;
    assert.equal(cold.status, 503);
    assert.equal(cold.body.warm, false);
    yield* finishProbes;
    const warm = yield* get;
    assert.equal(warm.status, 200);
    assert.equal(warm.body.warm, true);
  }).pipe(Effect.scoped),
);
