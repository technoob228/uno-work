import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Stream } from "effect";

import {
  BROWSER_BRIDGE_TOKEN_ENV,
  BrowserBridge,
  BrowserBridgeTest,
  isAllowedBridgeCommand,
  makeBrowserBridge,
  normalizeBridgeRequestContext,
} from "./browserBridge.ts";

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

it.effect("scopes bridge tokens to a thread context and resolves it back on authorize", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBrowserBridge({
      token: "base-token",
      baseUrl: "http://127.0.0.1:4100",
    });

    const context = { threadId: "thread-1", cwd: "/tmp/project-a" };
    const scoped = bridge.scopedEnvironment(context);
    const scopedToken = scoped[BROWSER_BRIDGE_TOKEN_ENV]!;
    assert.isString(scopedToken);
    assert.notEqual(scopedToken, "base-token");

    // Тот же контекст — тот же токен; другой контекст — другой токен.
    assert.equal(bridge.scopedEnvironment(context)[BROWSER_BRIDGE_TOKEN_ENV], scopedToken);
    assert.notEqual(
      bridge.scopedEnvironment({ threadId: "thread-2", cwd: "/tmp/project-b" })[
        BROWSER_BRIDGE_TOKEN_ENV
      ],
      scopedToken,
    );

    assert.deepEqual(bridge.authorize(`Bearer ${scopedToken}`), { context });
    assert.deepEqual(bridge.authorize("Bearer base-token"), { context: undefined });
    assert.isNull(bridge.authorize("Bearer unknown-token"));
    assert.isNull(bridge.authorize(undefined));
  }),
);

it.effect("attaches the request context to published bridge events", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBrowserBridge({
      token: "base-token",
      baseUrl: "http://127.0.0.1:4100",
    });

    const event = yield* bridge.publishOpenUrl("https://example.com/", { cwd: "/tmp/project-a" });
    assert.equal(event.type, "openUrl");
    if (event.type !== "openUrl") throw new Error("Expected openUrl event.");
    assert.deepEqual(event.context, { cwd: "/tmp/project-a" });

    const plain = yield* bridge.publishOpenUrl("https://example.com/");
    assert.equal(plain.type, "openUrl");
    if (plain.type !== "openUrl") throw new Error("Expected openUrl event.");
    assert.isUndefined(plain.context);
  }),
);

it.effect("tracks live stream subscribers", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;

    const awaitSubscriberCount = (expected: number) =>
      Effect.gen(function* () {
        for (let i = 0; i < 10_000; i++) {
          if ((yield* browserBridge.subscriberCount) === expected) return;
          yield* Effect.yieldNow;
        }
        throw new Error(`Subscriber count did not reach ${expected}.`);
      });

    assert.equal(yield* browserBridge.subscriberCount, 0);
    assert.isFalse(yield* browserBridge.hasSubscribers);

    const first = yield* browserBridge.stream.pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitSubscriberCount(1);
    assert.isTrue(yield* browserBridge.hasSubscribers);

    const second = yield* browserBridge.stream.pipe(Stream.runDrain, Effect.forkScoped);
    yield* awaitSubscriberCount(2);

    yield* Fiber.interrupt(first);
    yield* awaitSubscriberCount(1);

    yield* Fiber.interrupt(second);
    yield* awaitSubscriberCount(0);
    assert.isFalse(yield* browserBridge.hasSubscribers);
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

it("validates the fullPage screenshot flag", () => {
  assert.isTrue(isAllowedBridgeCommand({ command: "screenshot", fullPage: true }));
  assert.isTrue(isAllowedBridgeCommand({ command: "screenshot" }));
  assert.isFalse(isAllowedBridgeCommand({ command: "screenshot", fullPage: "yes" }));
});

it("normalizes bridge request contexts", () => {
  assert.deepEqual(normalizeBridgeRequestContext({ threadId: " t1 ", cwd: " /a " }), {
    threadId: "t1",
    cwd: "/a",
  });
  assert.deepEqual(normalizeBridgeRequestContext({ cwd: "/a" }), { cwd: "/a" });
  assert.isUndefined(normalizeBridgeRequestContext({ threadId: "  ", cwd: "" }));
  assert.isUndefined(normalizeBridgeRequestContext({ cwd: "x".repeat(5000) }));
});
