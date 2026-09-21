import { assert, it } from "@effect/vitest";
import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { withUnoSignIn } from "./http.ts";

const auth: ServerAuthDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-session-token"],
  sessionCookieName: "t3_session",
};

const identity = (boxId: number | null) =>
  Layer.succeed(UnoBoxIdentity, { current: Effect.succeed(boxId), probe: Effect.void });

it.effect("a signed-out browser on an Uno box is offered Sign in with Uno", () =>
  Effect.gen(function* () {
    const session = yield* withUnoSignIn({ authenticated: false, auth });
    assert.strictEqual(session.auth.unoSignIn?.boxId, 1806);
    assert.match(session.auth.unoSignIn?.consoleUrl ?? "", /^https?:\/\//);
  }).pipe(Effect.provide(identity(1806))),
);

it.effect("a machine that is not a known Uno box keeps the pairing-token flow", () =>
  Effect.gen(function* () {
    const session = yield* withUnoSignIn({ authenticated: false, auth });
    assert.strictEqual(session.auth.unoSignIn, undefined);
  }).pipe(Effect.provide(identity(null))),
);

it.effect("without box identity wired at all nothing changes", () =>
  Effect.gen(function* () {
    const session = yield* withUnoSignIn({ authenticated: false, auth });
    assert.strictEqual(session.auth.unoSignIn, undefined);
  }),
);
