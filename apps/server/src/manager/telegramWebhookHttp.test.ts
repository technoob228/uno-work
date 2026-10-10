/**
 * `POST /api/telegram/webhook/:hook` — the door Telegram knocks on. No Uno
 * session exists for this caller; the route passes the hook id and the secret
 * header to the connector and turns its verdict into the status Telegram acts
 * on (200 — forget the update; anything else — deliver it again).
 */
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { telegramWebhookRouteLayer } from "./http.ts";
import {
  ManagerTelegramService,
  type ManagerTelegramServiceShape,
  type TelegramWebhookReceipt,
} from "./Layers/TelegramConnector.ts";
import { TELEGRAM_WEBHOOK_SECRET_HEADER } from "./telegramWebhook.ts";

const makeFixture = (verdict: (secret: string | null) => TelegramWebhookReceipt) =>
  Effect.gen(function* () {
    const seen: Array<{ hookId: string; secret: string | null; update: unknown }> = [];
    const telegram = Layer.succeed(ManagerTelegramService, {
      receiveWebhookUpdate: (input) =>
        Effect.gen(function* () {
          const receipt = verdict(input.secret);
          // Like the connector: a stranger's body is never read.
          const update = receipt === "unknown" ? "(not read)" : yield* input.readUpdate;
          seen.push({ hookId: input.hookId, secret: input.secret, update });
          return receipt === "accepted" && update === null ? "invalid" : receipt;
        }),
    } as Partial<ManagerTelegramServiceShape> as ManagerTelegramServiceShape);
    const context = yield* Layer.build(telegram);
    const { handler, dispose } = HttpRouter.toWebHandler(telegramWebhookRouteLayer, {
      disableLogger: true,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
    const post = (init: { secret?: string; body: string; headers?: Record<string, string> }) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://127.0.0.1/api/telegram/webhook/abc123", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(init.secret !== undefined
                ? { [TELEGRAM_WEBHOOK_SECRET_HEADER]: init.secret }
                : {}),
              ...init.headers,
            },
            body: init.body,
          }),
          context,
        );
        return response.status;
      });
    return { post, seen };
  });

it.effect("Telegram with the right secret: the update is passed on and answered 200", () =>
  Effect.gen(function* () {
    const { post, seen } = yield* makeFixture((secret) =>
      secret === "right" ? "accepted" : "unknown",
    );
    const status = yield* post({ secret: "right", body: JSON.stringify({ update_id: 7 }) });
    assert.equal(status, 200);
    assert.deepEqual(seen, [{ hookId: "abc123", secret: "right", update: { update_id: 7 } }]);
  }).pipe(Effect.scoped),
);

it.effect("no secret or a wrong one: 404, and nothing of the request is read", () =>
  Effect.gen(function* () {
    const { post, seen } = yield* makeFixture((secret) =>
      secret === "right" ? "accepted" : "unknown",
    );
    assert.equal(yield* post({ body: JSON.stringify({ update_id: 7 }) }), 404);
    assert.equal(yield* post({ secret: "wrong", body: JSON.stringify({ update_id: 7 }) }), 404);
    assert.deepEqual(
      seen.map((entry) => entry.update),
      ["(not read)", "(not read)"],
    );
  }).pipe(Effect.scoped),
);

it.effect("not stored: 503, so Telegram delivers the update again", () =>
  Effect.gen(function* () {
    const { post } = yield* makeFixture(() => "unavailable");
    assert.equal(yield* post({ secret: "right", body: JSON.stringify({ update_id: 7 }) }), 503);
  }).pipe(Effect.scoped),
);

it.effect("not JSON, not an update: 400", () =>
  Effect.gen(function* () {
    const { post, seen } = yield* makeFixture(() => "accepted");
    assert.equal(yield* post({ secret: "right", body: "<html>" }), 400);
    assert.equal(seen[0]?.update, null);
    const invalid = yield* makeFixture(() => "invalid");
    assert.equal(yield* invalid.post({ secret: "right", body: JSON.stringify({ a: 1 }) }), 400);
  }).pipe(Effect.scoped),
);

it.effect("a body far too big for a Telegram update is refused unread", () =>
  Effect.gen(function* () {
    const { post, seen } = yield* makeFixture(() => "accepted");
    const status = yield* post({
      secret: "right",
      body: "{}",
      headers: { "content-length": String(5 * 1024 * 1024) },
    });
    assert.equal(status, 413);
    assert.equal(seen.length, 0);
  }).pipe(Effect.scoped),
);
