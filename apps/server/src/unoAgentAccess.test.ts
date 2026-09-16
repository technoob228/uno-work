import { assert, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "./auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { UnoAgentAccess, UnoAgentAccessLive } from "./unoAgentAccess.ts";
import { UNO_AGENT_TOKEN_SECRET_KEY } from "./unoBoxIdentity.ts";

const ACCOUNT_KEY = "uno_usr_abcd1234";
const BOX_ID = 42;

/** In-memory secret store seeded with a previously minted token. */
const secretStoreLayer = (seed: Record<string, string>) =>
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

interface MintCall {
  readonly url: string;
  readonly access: unknown;
}

/** Captures the mint request instead of talking to the control plane. */
function stubControlPlane(calls: MintCall[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { access?: unknown }) : {};
    calls.push({ url, access: body.access });
    return new Response(JSON.stringify({ token: "uno_agt_minted", expires_at: null }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const storedToken = (access: string) =>
  JSON.stringify({
    token: "uno_agt_stale",
    access,
    boxId: BOX_ID,
    expiresAt: null,
    // Last 4 chars of the account key — the daemon's own fingerprint scheme.
    mintedBy: ACCOUNT_KEY.slice(-4),
  });

const runWithAccess = (agentAccess: "read" | "manage" | "purchase", calls: MintCall[]) =>
  Effect.gen(function* () {
    const access = yield* UnoAgentAccess;
    return yield* access.environment();
  }).pipe(
    Effect.provide(
      UnoAgentAccessLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ uno: { apiKey: ACCOUNT_KEY, agentAccess } }),
            secretStoreLayer({ [UNO_AGENT_TOKEN_SECRET_KEY]: storedToken("stale") }),
          ),
        ),
      ),
    ),
    Effect.tap(() => Effect.sync(() => calls)),
  );

it.effect("never mints a purchasing agent token, even when settings still say purchase", () =>
  Effect.gen(function* () {
    const calls: MintCall[] = [];
    const restore = stubControlPlane(calls);
    const environment = yield* runWithAccess("purchase", calls).pipe(
      Effect.ensuring(Effect.sync(restore)),
    );

    assert.lengthOf(calls, 1);
    assert.include(calls[0]!.url, `/api/v1/boxes/${BOX_ID}/agent-token`);
    // "purchase" is clamped: the env token can never carry `infra:purchase`.
    assert.strictEqual(calls[0]!.access, "manage");
    assert.strictEqual(environment["UNO_AGENT_API_KEY"], "uno_agt_minted");
    assert.strictEqual(environment["UNO_BOX_ID"], String(BOX_ID));
  }),
);

it.effect("keeps the owner-chosen read level as the default narrow token", () =>
  Effect.gen(function* () {
    const calls: MintCall[] = [];
    const restore = stubControlPlane(calls);
    yield* runWithAccess("read", calls).pipe(Effect.ensuring(Effect.sync(restore)));

    assert.lengthOf(calls, 1);
    assert.strictEqual(calls[0]!.access, "read");
  }),
);

it.effect("hands agents nothing when access is off", () =>
  Effect.gen(function* () {
    const calls: MintCall[] = [];
    const restore = stubControlPlane(calls);
    const environment = yield* Effect.gen(function* () {
      const access = yield* UnoAgentAccess;
      return yield* access.environment();
    }).pipe(
      Effect.provide(
        UnoAgentAccessLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({
                uno: { apiKey: ACCOUNT_KEY, agentAccess: "off" },
              }),
              secretStoreLayer({ [UNO_AGENT_TOKEN_SECRET_KEY]: storedToken("purchase") }),
            ),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(restore)),
    );

    assert.deepEqual(environment, {});
    assert.lengthOf(calls, 0);
  }),
);
