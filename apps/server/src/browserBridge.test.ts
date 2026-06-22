import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Stream } from "effect";

import { BrowserBridge, BrowserBridgeTest } from "./browserBridge.ts";

it.effect("delivers browser command results to the pending publisher", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const eventFiber = yield* browserBridge.stream.pipe(
      Stream.runHead,
      Effect.map((option) => Option.getOrThrow(option)),
      Effect.forkScoped,
    );
    const commandFiber = yield* browserBridge
      .publishCommand({
        command: "state",
        timeoutMs: 1_000,
      })
      .pipe(Effect.forkScoped);

    const event = yield* Fiber.join(eventFiber);
    assert.equal(event.type, "command");
    if (event.type !== "command") {
      throw new Error("Expected browser bridge command event.");
    }

    const accepted = yield* browserBridge.resolveCommandResult({
      commandId: event.commandId,
      responseToken: event.responseToken,
      ok: true,
      data: {
        url: "https://example.com/",
      },
    });
    assert.isTrue(accepted);

    const result = yield* Fiber.join(commandFiber);
    assert.deepEqual(result, {
      ok: true,
      commandId: event.commandId,
      data: {
        url: "https://example.com/",
      },
    });
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

it.effect("rejects browser command results with the wrong response token", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const eventFiber = yield* browserBridge.stream.pipe(
      Stream.runHead,
      Effect.map((option) => Option.getOrThrow(option)),
      Effect.forkScoped,
    );
    const commandFiber = yield* browserBridge
      .publishCommand({
        command: "state",
        timeoutMs: 1_000,
      })
      .pipe(Effect.forkScoped);

    const event = yield* Fiber.join(eventFiber);
    assert.equal(event.type, "command");
    if (event.type !== "command") {
      throw new Error("Expected browser bridge command event.");
    }

    const accepted = yield* browserBridge.resolveCommandResult({
      commandId: event.commandId,
      responseToken: "wrong-token",
      ok: true,
    });
    assert.isFalse(accepted);

    const corrected = yield* browserBridge.resolveCommandResult({
      commandId: event.commandId,
      responseToken: event.responseToken,
      ok: false,
      error: "Browser command failed.",
    });
    assert.isTrue(corrected);

    const result = yield* Fiber.join(commandFiber);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Browser command failed.");
  }).pipe(Effect.provide(BrowserBridgeTest)),
);
