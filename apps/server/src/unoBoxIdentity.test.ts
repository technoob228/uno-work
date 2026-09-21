import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { parseSettingsBoxId, UnoBoxIdentity, UnoBoxIdentityLive } from "./unoBoxIdentity.ts";

const emptySecretStore = Layer.succeed(ServerSecretStore, {
  get: () => Effect.succeed(null),
  set: () => Effect.void,
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
  remove: () => Effect.void,
});

it("parseSettingsBoxId accepts only positive integers", () => {
  assert.strictEqual(parseSettingsBoxId(1806), 1806);
  assert.strictEqual(parseSettingsBoxId(null), null);
  assert.strictEqual(parseSettingsBoxId(undefined), null);
  assert.strictEqual(parseSettingsBoxId(0), null);
  assert.strictEqual(parseSettingsBoxId(1.5), null);
});

it.effect("the box id the console wrote into settings is the machine's identity", () =>
  Effect.gen(function* () {
    const identity = yield* UnoBoxIdentity;
    assert.strictEqual(yield* identity.current, 1806);
    // The probe must not go to the control plane: the answer is already known.
    yield* identity.probe;
    assert.strictEqual(yield* identity.current, 1806);
  }).pipe(
    Effect.provide(
      UnoBoxIdentityLive.pipe(
        Layer.provide(
          ServerSettingsService.layerTest({ uno: { apiKey: "unollm_ai", boxId: 1806 } }),
        ),
        Layer.provide(emptySecretStore),
      ),
    ),
  ),
);

it.effect("the box token never reaches the browser", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const redacted = redactServerSettingsForClient(yield* settings.getSettings);
    assert.strictEqual(redacted.uno.boxToken, undefined);
    assert.strictEqual(redacted.uno.boxId, 1806);
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({ uno: { boxId: 1806, boxToken: "uno_agt_secret" } }),
    ),
  ),
);
