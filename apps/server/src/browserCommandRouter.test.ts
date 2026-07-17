import { assert, it } from "@effect/vitest";
import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  ServerBrowserSettings,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import { BrowserBridge, BrowserBridgeTest } from "./browserBridge.ts";
import {
  decideBrowserExecutorTarget,
  executeBridgeCommand,
  executeBridgeOpenUrl,
} from "./browserCommandRouter.ts";
import { ServerBrowser } from "./serverBrowser.ts";
import { ServerSettingsService } from "./serverSettings.ts";

it("decides the executor target from settings and subscriber presence", () => {
  assert.equal(decideBrowserExecutorTarget({ executor: "server", hasSubscribers: true }), "server");
  assert.equal(
    decideBrowserExecutorTarget({ executor: "server", hasSubscribers: false }),
    "server",
  );
  assert.equal(decideBrowserExecutorTarget({ executor: "local", hasSubscribers: true }), "client");
  assert.equal(decideBrowserExecutorTarget({ executor: "local", hasSubscribers: false }), "client");
  assert.equal(decideBrowserExecutorTarget({ executor: "auto", hasSubscribers: true }), "client");
  assert.equal(decideBrowserExecutorTarget({ executor: "auto", hasSubscribers: false }), "server");
});

/** Фейковый серверный исполнитель: записывает команды, отвечает маркером. */
function makeFakeServerBrowser() {
  const calls: BrowserAutomationCommandInput[] = [];
  const layer = Layer.succeed(ServerBrowser, {
    execute: (input) =>
      Effect.sync((): BrowserAutomationCommandResult => {
        calls.push(input);
        return { ok: true, commandId: "fake", data: { via: "server" } };
      }),
    shutdown: Effect.void,
  });
  return { calls, layer };
}

function routerLayers(input: {
  browser: Partial<ServerBrowserSettings>;
  serverBrowser: Layer.Layer<ServerBrowser>;
}) {
  return Layer.mergeAll(
    BrowserBridgeTest,
    input.serverBrowser,
    ServerSettingsService.layerTest({ browser: input.browser }),
  );
}

it.effect("routes commands to the server executor when executor=server", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const result = yield* executeBridgeCommand({ command: "state" }, undefined).pipe(
      Effect.provide(routerLayers({ browser: { executor: "server" }, serverBrowser: fake.layer })),
    );
    assert.deepEqual(result, { ok: true, commandId: "fake", data: { via: "server" } });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.command, "state");
  }),
);

it.effect("falls back to the server executor when executor=auto and nobody is subscribed", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const result = yield* executeBridgeCommand(
      { command: "screenshot" },
      { cwd: "/tmp/project-a" },
    ).pipe(
      Effect.provide(routerLayers({ browser: { executor: "auto" }, serverBrowser: fake.layer })),
    );
    assert.isTrue(result.ok);
    assert.equal(fake.calls.length, 1);
  }),
);

it.effect("prefers the connected client when executor=auto and a subscriber is live", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({ browser: { executor: "auto" }, serverBrowser: fake.layer });

    const result = yield* Effect.gen(function* () {
      const browserBridge = yield* BrowserBridge;
      // Клиент-респондер: отвечает на каждое command-событие, как это делает
      // BrowserBridgeListener через /api/browser/command/result.
      const responder = yield* browserBridge.stream.pipe(
        Stream.runForEach((event) =>
          event.type === "command"
            ? browserBridge
                .resolveCommandResult({
                  commandId: event.commandId,
                  responseToken: event.responseToken,
                  ok: true,
                  data: { via: "client" },
                })
                .pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      // Дождаться фактической подписки, прежде чем роутер посмотрит на счётчик.
      for (let i = 0; i < 10_000; i++) {
        if ((yield* browserBridge.subscriberCount) > 0) break;
        yield* Effect.yieldNow;
      }

      const commandResult = yield* executeBridgeCommand(
        { command: "state", timeoutMs: 1_000 },
        undefined,
      );
      yield* Fiber.interrupt(responder);
      return commandResult;
    }).pipe(Effect.provide(layers));

    assert.isTrue(result.ok);
    assert.deepEqual(result.data, { via: "client" });
    assert.equal(fake.calls.length, 0);
  }),
);

it.effect("fails fast when executor=local and no client is connected", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const result = yield* executeBridgeCommand({ command: "state" }, undefined).pipe(
      Effect.provide(routerLayers({ browser: { executor: "local" }, serverBrowser: fake.layer })),
    );
    assert.isFalse(result.ok);
    assert.include(result.error ?? "", "browserExecutor=local");
    assert.equal(fake.calls.length, 0);
  }),
);

it.effect("blocks every server-side command when serverAutomationLevel=off", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({
      browser: { executor: "server", serverAutomationLevel: "off" },
      serverBrowser: fake.layer,
    });
    const command = yield* executeBridgeCommand({ command: "state" }, undefined).pipe(
      Effect.provide(layers),
    );
    assert.isFalse(command.ok);
    assert.include(command.error ?? "", "serverAutomationLevel=off");

    const open = yield* executeBridgeOpenUrl("https://example.com/", undefined).pipe(
      Effect.provide(layers),
    );
    assert.isFalse(open.ok);
    assert.equal(fake.calls.length, 0);
  }),
);

it.effect("safe mode blocks only evaluate on the server executor", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({
      browser: { executor: "server", serverAutomationLevel: "safe" },
      serverBrowser: fake.layer,
    });
    const blocked = yield* executeBridgeCommand(
      { command: "evaluate", script: "1 + 1" },
      undefined,
    ).pipe(Effect.provide(layers));
    assert.isFalse(blocked.ok);
    assert.equal(blocked.error, "Browser automation safe mode blocks evaluate.");

    const allowed = yield* executeBridgeCommand({ command: "state" }, undefined).pipe(
      Effect.provide(layers),
    );
    assert.isTrue(allowed.ok);
    assert.equal(fake.calls.length, 1);
  }),
);

it.effect("opens URLs on the server executor when nobody is subscribed", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const result = yield* executeBridgeOpenUrl("https://example.com/", {
      cwd: "/tmp/project-a",
    }).pipe(
      Effect.provide(routerLayers({ browser: { executor: "auto" }, serverBrowser: fake.layer })),
    );
    assert.isTrue(result.ok);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0], { command: "openUrl", url: "https://example.com/" });
  }),
);
