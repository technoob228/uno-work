import { assert, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "./auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { UNO_GATEWAY_KEY_SECRET_KEY, UnoGatewayKey, UnoGatewayKeyLive } from "./unoGatewayKey.ts";

const ACCOUNT_KEY = "uno_usr_abcd1234";

const secretStoreLayer = (seed: Record<string, string> = {}) =>
  Layer.effect(
    ServerSecretStore,
    Effect.gen(function* () {
      const store = yield* Ref.make(
        new Map(
          Object.entries(seed).map(([key, value]) => [
            key,
            Uint8Array.from(new TextEncoder().encode(value)),
          ]),
        ),
      );
      return {
        get: (name) => Ref.get(store).pipe(Effect.map((map) => map.get(name) ?? null)),
        set: (name, value) =>
          Ref.update(store, (map) => new Map(map).set(name, Uint8Array.from(value))),
        getOrCreateRandom: (name) =>
          Ref.get(store).pipe(Effect.map((map) => map.get(name) ?? new Uint8Array())),
        remove: (name) =>
          Ref.update(store, (map) => {
            const next = new Map(map);
            next.delete(name);
            return next;
          }),
      } satisfies ServerSecretStoreShape;
    }),
  );

interface Call {
  readonly url: string;
  readonly authorization: string | undefined;
}

function stubControlPlane(calls: Call[], response: unknown, status = 201): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      authorization: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const harnessKeyWith = (apiKey: string, seed: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const gateway = yield* UnoGatewayKey;
    return yield* gateway.harnessKey();
  }).pipe(
    Effect.provide(
      UnoGatewayKeyLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ uno: { apiKey } }),
            secretStoreLayer(seed),
          ),
        ),
      ),
    ),
  );

it.effect("mints a gateway-only child key instead of handing over the account key", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { key: "unollm_child", id: 7 });
    const key = yield* harnessKeyWith(ACCOUNT_KEY).pipe(Effect.ensuring(Effect.sync(restore)));

    assert.strictEqual(key, "unollm_child");
    assert.notStrictEqual(key, ACCOUNT_KEY);
    assert.lengthOf(calls, 1);
    assert.include(calls[0]!.url, "/api/v1/llm/keys");
    assert.strictEqual(calls[0]!.authorization, `Bearer ${ACCOUNT_KEY}`);
  }),
);

it.effect("passes through a key that is already gateway-scoped, without minting", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { key: "unollm_unused" });
    const key = yield* harnessKeyWith("unollm_frombox").pipe(Effect.ensuring(Effect.sync(restore)));

    assert.strictEqual(key, "unollm_frombox");
    assert.lengthOf(calls, 0);
  }),
);

it.effect("reuses the stored child key for the same account key", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { key: "unollm_fresh" });
    const key = yield* harnessKeyWith(ACCOUNT_KEY, {
      [UNO_GATEWAY_KEY_SECRET_KEY]: JSON.stringify({
        secret: "unollm_stored",
        mintedBy: ACCOUNT_KEY.slice(-4),
      }),
    }).pipe(Effect.ensuring(Effect.sync(restore)));

    assert.strictEqual(key, "unollm_stored");
    assert.lengthOf(calls, 0);
  }),
);

it.effect("re-mints when the stored child key was minted by a different account key", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { key: "unollm_fresh" });
    // The stored child belongs to a rotated/previous account key — it is
    // stale and must not be handed to harnesses.
    const key = yield* harnessKeyWith(ACCOUNT_KEY, {
      [UNO_GATEWAY_KEY_SECRET_KEY]: JSON.stringify({
        secret: "unollm_stale",
        mintedBy: "old0",
      }),
    }).pipe(Effect.ensuring(Effect.sync(restore)));

    assert.strictEqual(key, "unollm_fresh");
    assert.lengthOf(calls, 1);
    assert.include(calls[0]!.url, "/api/v1/llm/keys");
  }),
);

it.effect("hands over nothing when no key is configured at all", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { key: "unollm_unused" });
    const key = yield* harnessKeyWith("").pipe(Effect.ensuring(Effect.sync(restore)));

    assert.strictEqual(key, "");
    assert.lengthOf(calls, 0);
  }),
);

it.effect("hands over nothing when the child key cannot be minted", () =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const restore = stubControlPlane(calls, { error: "UNAUTHORIZED" }, 401);
    const key = yield* harnessKeyWith(ACCOUNT_KEY).pipe(Effect.ensuring(Effect.sync(restore)));

    // Fail closed: no LLM key beats an account key in the agent's environment.
    assert.strictEqual(key, "");
  }),
);

// Work-box: the daemon starts without a key, the console writes unollm_ into
// settings seconds later. The answer cached at startup must not outlive it —
// otherwise the rebuilt uno provider fetched an empty catalog forever and the
// first chat went to a logged-out Claude.
it.effect("a key written after startup is picked up at once, not after the cache TTL", () =>
  Effect.gen(function* () {
    const gateway = yield* UnoGatewayKey;
    const settings = yield* ServerSettingsService;
    assert.strictEqual(yield* gateway.harnessKey(), "");
    yield* settings.updateSettings({ uno: { apiKey: "unollm_written_later" } });
    assert.strictEqual(yield* gateway.harnessKey(), "unollm_written_later");
  }).pipe(
    Effect.provide(
      UnoGatewayKeyLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ uno: { apiKey: "" } }),
            secretStoreLayer(),
          ),
        ),
      ),
    ),
  ),
);
