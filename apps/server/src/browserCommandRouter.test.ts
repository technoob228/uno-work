import { assert, it } from "@effect/vitest";
import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  ServerBrowserSettings,
} from "@t3tools/contracts";
import {
  emptyFrameMessage,
  isEmptyFrameError,
  PNG_DATA_URL_PREFIX,
} from "@t3tools/shared/browserScreenshot";
import { Effect, Fiber, Layer, Scope, Stream } from "effect";

import { BrowserBridge, BrowserBridgeTest } from "./browserBridge.ts";
import {
  decideBrowserExecutorTarget,
  executeBridgeCommand,
  executeBridgeOpenUrl,
} from "./browserCommandRouter.ts";
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { ServerBrowser, unavailableServerBrowserLive } from "./serverBrowser.ts";
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

it("keeps the browser where the agent is on a machine in the cloud", () => {
  // Облачная машина: подписанный клиент (ноутбук) не забирает браузер себе.
  assert.equal(
    decideBrowserExecutorTarget({ executor: "auto", hasSubscribers: true, hostedMachine: true }),
    "server",
  );
  assert.equal(
    decideBrowserExecutorTarget({ executor: "auto", hasSubscribers: false, hostedMachine: true }),
    "server",
  );
  // Явный выбор в настройках сильнее правила.
  assert.equal(
    decideBrowserExecutorTarget({ executor: "local", hasSubscribers: true, hostedMachine: true }),
    "client",
  );
});

/** Фейковый серверный исполнитель: записывает команды, отвечает маркером. */
function makeFakeServerBrowser(
  reply: (input: BrowserAutomationCommandInput) => BrowserAutomationCommandResult = () => ({
    ok: true,
    commandId: "fake",
    data: { via: "server" },
  }),
) {
  const calls: BrowserAutomationCommandInput[] = [];
  const layer = Layer.succeed(ServerBrowser, {
    execute: (input) =>
      Effect.sync((): BrowserAutomationCommandResult => {
        calls.push(input);
        return reply(input);
      }),
    live: unavailableServerBrowserLive,
    shutdown: Effect.void,
  });
  return { calls, layer };
}

function routerLayers(input: {
  browser: Partial<ServerBrowserSettings>;
  serverBrowser: Layer.Layer<ServerBrowser>;
  mode?: ServerConfigShape["mode"];
}) {
  return Layer.mergeAll(
    BrowserBridgeTest,
    input.serverBrowser,
    ServerSettingsService.layerTest({ browser: input.browser }),
    // Роутер читает из конфига только режим: web = машина в облаке.
    Layer.succeed(ServerConfig, { mode: input.mode ?? "desktop" } as ServerConfigShape),
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

/**
 * Подключённый клиент-респондер: отвечает на каждое command-событие так же,
 * как BrowserBridgeListener через /api/browser/command/result. Возвращает
 * список того, что клиенту прислали.
 */
const withConnectedClient = <A, R>(
  reply: (input: BrowserAutomationCommandInput) => {
    ok: boolean;
    data?: unknown;
    error?: string;
  },
  body: (received: BrowserAutomationCommandInput[]) => Effect.Effect<A, never, R>,
): Effect.Effect<A, never, R | BrowserBridge | Scope.Scope> =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const received: BrowserAutomationCommandInput[] = [];
    const responder = yield* browserBridge.stream.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "command") return Effect.void;
        received.push(event.input);
        const result = reply(event.input);
        return browserBridge
          .resolveCommandResult({
            commandId: event.commandId,
            responseToken: event.responseToken,
            ok: result.ok,
            ...(result.data !== undefined ? { data: result.data } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          })
          .pipe(Effect.asVoid);
      }),
      Effect.forkScoped,
    );
    for (let i = 0; i < 10_000; i++) {
      if ((yield* browserBridge.subscriberCount) > 0) break;
      yield* Effect.yieldNow;
    }
    const outcome = yield* body(received);
    yield* Fiber.interrupt(responder);
    return outcome;
  });

it.effect("routes fullPage screenshots to the headless executor even with a live client", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({ browser: { executor: "auto" }, serverBrowser: fake.layer });

    const { result, received } = yield* withConnectedClient(
      () => ({ ok: true, data: { via: "client" } }),
      (received) =>
        executeBridgeCommand({ command: "screenshot", fullPage: true }, undefined).pipe(
          Effect.map((result) => ({ result, received })),
        ),
    ).pipe(Effect.provide(layers));

    assert.isTrue(result.ok);
    assert.deepEqual(result.data, { via: "server" });
    // Панель не умеет снимать полную страницу — её вообще не спрашивали.
    assert.deepEqual(received, []);
    assert.deepEqual(fake.calls, [{ command: "screenshot", fullPage: true }]);
  }),
);

it.effect("retakes a blank panel frame on the headless executor at the panel's URL", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser((input) =>
      input.command === "screenshot"
        ? { ok: true, commandId: "fake", data: { dataUrl: `${PNG_DATA_URL_PREFIX}iVBORw0KGgo=` } }
        : { ok: true, commandId: "fake", data: { via: "server" } },
    );
    const layers = routerLayers({ browser: { executor: "auto" }, serverBrowser: fake.layer });

    const { result, received } = yield* withConnectedClient(
      (input) =>
        input.command === "screenshot"
          ? { ok: false, error: emptyFrameMessage({ capturedBy: "panel", attempts: 3, bytes: 0 }) }
          : { ok: true, data: { url: "https://app.example.com/dashboard" } },
      (received) =>
        executeBridgeCommand({ command: "screenshot" }, undefined).pipe(
          Effect.map((result) => ({ result, received })),
        ),
    ).pipe(Effect.provide(layers));

    assert.isTrue(result.ok);
    assert.equal((result.data as { fallbackFrom?: string }).fallbackFrom, "panel");
    // Панель спросили о screenshot, затем о текущем URL для headless-дубля.
    assert.deepEqual(
      received.map((input) => input.command),
      ["screenshot", "state"],
    );
    assert.deepEqual(fake.calls[0], {
      command: "openUrl",
      url: "https://app.example.com/dashboard",
    });
    assert.equal(fake.calls[1]?.command, "screenshot");
  }),
);

it.effect("reports a blank frame as an error instead of a successful empty PNG", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({
      // Фолбэка нет — клиентский пустой кадр должен стать честной ошибкой.
      browser: { executor: "auto", serverAutomationLevel: "off" },
      serverBrowser: fake.layer,
    });

    const result = yield* withConnectedClient(
      // Так отвечает клиент старой версии: ok с одним префиксом data URL.
      () => ({ ok: true, data: { dataUrl: PNG_DATA_URL_PREFIX } }),
      () => executeBridgeCommand({ command: "screenshot" }, undefined),
    ).pipe(Effect.provide(layers));

    assert.isFalse(result.ok);
    assert.isTrue(isEmptyFrameError(result.error));
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

it.effect("on a machine in the cloud a connected laptop never takes the agent's browser", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({
      browser: { executor: "auto" },
      serverBrowser: fake.layer,
      mode: "web",
    });

    const { command, openUrl, received } = yield* withConnectedClient(
      () => ({ ok: true, data: { via: "client" } }),
      (received) =>
        Effect.all({
          command: executeBridgeCommand({ command: "state" }, { threadId: "t-1" }),
          openUrl: executeBridgeOpenUrl("https://example.com", { threadId: "t-1" }),
        }).pipe(Effect.map((results) => ({ ...results, received }))),
    ).pipe(Effect.provide(layers));

    assert.deepEqual(command.data, { via: "server" });
    assert.isTrue(openUrl.ok);
    assert.deepEqual(
      fake.calls.map((call) => call.command),
      ["state", "openUrl"],
    );
    assert.equal(received.length, 0);
  }),
);

it.effect("requestHelp on the app's own panel answers with a clear refusal", () =>
  Effect.gen(function* () {
    const fake = makeFakeServerBrowser();
    const layers = routerLayers({ browser: { executor: "local" }, serverBrowser: fake.layer });

    const { result, received } = yield* withConnectedClient(
      () => ({ ok: true }),
      (received) =>
        executeBridgeCommand({ command: "requestHelp", text: "Log in, please" }, undefined).pipe(
          Effect.map((result) => ({ result, received })),
        ),
    ).pipe(Effect.provide(layers));

    assert.isFalse(result.ok);
    assert.include(result.error ?? "", "ask them in chat");
    assert.equal(received.length, 0);
    assert.equal(fake.calls.length, 0);
  }),
);
