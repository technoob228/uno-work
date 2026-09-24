import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  BROWSER_BRIDGE_TOKEN_ENV,
  BrowserBridge,
  BrowserBridgeTest,
  isAllowedBridgeCommand,
  normalizeTabScope,
  isAllowedBridgeFilePath,
  makeBrowserBridge,
  normalizeBridgeRequestContext,
  requireBridgeThread,
  BROWSER_BRIDGE_URL_ENV,
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

    assert.deepEqual(bridge.authorize(`Bearer ${scopedToken}`), { context, kind: "thread" });
    // Базовый токен узнаётся, но тредом не представляется — ручки его отклонят.
    assert.deepEqual(bridge.authorize("Bearer base-token"), {
      context: undefined,
      kind: "legacy",
    });
    assert.isNull(bridge.authorize("Bearer unknown-token"));
    assert.isNull(bridge.authorize(undefined));
  }),
);

it.effect("keeps the machine-wide token out of harness environments", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBrowserBridge({
      token: "base-token",
      baseUrl: "http://127.0.0.1:4100",
    });

    // Инстанс без треда: адрес есть, токена нет.
    const instanceEnvironment = bridge.scopedEnvironment(undefined);
    assert.equal(instanceEnvironment[BROWSER_BRIDGE_URL_ENV], "http://127.0.0.1:4100");
    assert.isUndefined(instanceEnvironment[BROWSER_BRIDGE_TOKEN_ENV]);
    assert.isUndefined(
      bridge.scopedEnvironment({ cwd: "/tmp/project-a" })[BROWSER_BRIDGE_TOKEN_ENV],
    );

    // Унаследованный токен вычищается, а не переживает спавн инстанса.
    const merged = bridge.applyEnvironment(
      { PATH: "/usr/bin", [BROWSER_BRIDGE_TOKEN_ENV]: "stale-token" },
      undefined,
    );
    assert.isUndefined(merged[BROWSER_BRIDGE_TOKEN_ENV]);
    assert.equal(merged["PATH"], "/usr/bin");

    // Сессия треда токен получает.
    const sessionEnvironment = bridge.applyEnvironment(
      { PATH: "/usr/bin" },
      { threadId: "thread-1", cwd: "/tmp/project-a" },
    );
    const sessionToken = sessionEnvironment[BROWSER_BRIDGE_TOKEN_ENV];
    assert.isString(sessionToken);
    assert.notEqual(sessionToken, "base-token");
  }),
);

it.effect("refuses bridge calls that cannot name their thread", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBrowserBridge({
      token: "base-token",
      baseUrl: "http://127.0.0.1:4100",
    });
    const scopedToken = bridge.issueThreadToken({ threadId: "thread-1", cwd: "/tmp/project-a" });
    assert.isString(scopedToken);

    const unknown = requireBridgeThread(bridge.authorize("Bearer nope"));
    assert.isFalse(unknown.ok);
    assert.equal(unknown.ok ? 0 : unknown.status, 401);

    // Сессия, поднятая до обновления: отказ с причиной, а не тишина.
    const legacy = requireBridgeThread(bridge.authorize("Bearer base-token"));
    assert.isFalse(legacy.ok);
    assert.equal(legacy.ok ? 0 : legacy.status, 403);
    assert.equal(legacy.ok ? "" : legacy.error, "thread_context_required");
    assert.include(legacy.ok ? "" : legacy.message, "перезапусти агента");

    const thread = requireBridgeThread(bridge.authorize(`Bearer ${scopedToken}`));
    assert.isTrue(thread.ok);
    assert.equal(thread.ok ? thread.threadId : "", "thread-1");

    // Токен одного треда никогда не представляется другим.
    const otherToken = bridge.issueThreadToken({ threadId: "thread-2", cwd: "/tmp/project-a" });
    const other = requireBridgeThread(bridge.authorize(`Bearer ${otherToken}`));
    assert.equal(other.ok ? other.threadId : "", "thread-2");
    assert.notEqual(scopedToken, otherToken);
  }),
);

it.effect("validates bridge file paths", () =>
  Effect.sync(() => {
    assert.isTrue(isAllowedBridgeFilePath("/tmp/report.html"));
    assert.isTrue(isAllowedBridgeFilePath("/Users/me/My Docs/о работе.md"));
    assert.isTrue(isAllowedBridgeFilePath("~/notes/todo.md"));
    assert.isTrue(isAllowedBridgeFilePath("~"));
    assert.isTrue(isAllowedBridgeFilePath("C:\\work\\report.pdf"));
    assert.isFalse(isAllowedBridgeFilePath("relative/path.md"));
    assert.isFalse(isAllowedBridgeFilePath("./report.html"));
    assert.isFalse(isAllowedBridgeFilePath(""));
    assert.isFalse(isAllowedBridgeFilePath("/tmp/evil\npath"));
    assert.isFalse(isAllowedBridgeFilePath(42));
    assert.isFalse(isAllowedBridgeFilePath(undefined));
    assert.isFalse(isAllowedBridgeFilePath(`/tmp/${"a".repeat(5000)}`));
  }),
);

it.effect("publishes openFile events with the request context", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBrowserBridge({
      token: "base-token",
      baseUrl: "http://127.0.0.1:4100",
    });

    const event = yield* bridge.publishOpenFile("/tmp/report.html", { cwd: "/tmp/project-a" });
    assert.equal(event.type, "openFile");
    if (event.type !== "openFile") throw new Error("Expected openFile event.");
    assert.equal(event.path, "/tmp/report.html");
    assert.deepEqual(event.context, { cwd: "/tmp/project-a" });
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

it("keeps fillCredential out of reach for harnesses", () => {
  // Пароль в команду подставляет только сервер (vault.fill). Если команда
  // попадёт в allowlist bridge-эндпоинта, агент сможет и заполнять чужие формы,
  // и подсматривать значения через свой же запрос.
  assert.isFalse(
    isAllowedBridgeCommand({ command: "fillCredential", username: "u", password: "p" }),
  );
});

it("accepts the tab scope only for known levels", () => {
  assert.strictEqual(normalizeTabScope("chat"), "chat");
  assert.strictEqual(normalizeTabScope("project"), "project");
  assert.strictEqual(normalizeTabScope("global"), "global");
  assert.isUndefined(normalizeTabScope("everywhere"));
  assert.isUndefined(normalizeTabScope(undefined));
  assert.isUndefined(normalizeTabScope(42));
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

it.effect("replays pending secret requests to new stream subscribers", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const requestFiber = yield* browserBridge
      .publishSecretRequest({
        name: "API_KEY",
        targetFile: ".env",
        cwd: "/tmp/project",
        timeoutMs: 5_000,
      })
      .pipe(Effect.forkScoped);
    // Дать publishSecretRequest зарегистрировать pending до подписки.
    yield* Effect.yieldNow;

    const replayed = yield* browserBridge.stream.pipe(
      Stream.runHead,
      Effect.map((option) => Option.getOrThrow(option)),
    );
    assert.equal(replayed.type, "secretRequest");
    if (replayed.type !== "secretRequest") {
      throw new Error("Expected replayed secretRequest event.");
    }
    assert.equal(replayed.name, "API_KEY");

    const completed = yield* browserBridge.completeSecretRequest({
      requestId: replayed.requestId,
      responseToken: replayed.responseToken,
      outcome: { ok: true, name: "API_KEY", file: ".env" },
    });
    assert.isTrue(completed);
    const outcome = yield* Fiber.join(requestFiber);
    assert.deepEqual(outcome, { ok: true, name: "API_KEY", file: ".env" });
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

it.effect("supersedes a pending secret request for the same name and cwd", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const firstFiber = yield* browserBridge
      .publishSecretRequest({
        name: "API_KEY",
        targetFile: ".env",
        cwd: "/tmp/project",
        timeoutMs: 5_000,
      })
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const secondFiber = yield* browserBridge
      .publishSecretRequest({
        name: "API_KEY",
        targetFile: ".env",
        cwd: "/tmp/project",
        timeoutMs: 5_000,
      })
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;

    const firstOutcome = yield* Fiber.join(firstFiber);
    assert.isFalse(firstOutcome.ok);
    assert.include(firstOutcome.error ?? "", "Superseded");

    // Реплей нового подписчика содержит ровно один живой запрос — второй.
    const replayed = yield* browserBridge.stream.pipe(
      Stream.runHead,
      Effect.map((option) => Option.getOrThrow(option)),
    );
    assert.equal(replayed.type, "secretRequest");
    if (replayed.type !== "secretRequest") {
      throw new Error("Expected replayed secretRequest event.");
    }
    const completed = yield* browserBridge.completeSecretRequest({
      requestId: replayed.requestId,
      responseToken: replayed.responseToken,
      outcome: { ok: true, name: "API_KEY", file: ".env" },
    });
    assert.isTrue(completed);
    const secondOutcome = yield* Fiber.join(secondFiber);
    assert.deepEqual(secondOutcome, { ok: true, name: "API_KEY", file: ".env" });
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

const waitForSubscribers = (expected: number) =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      if ((yield* browserBridge.subscriberCount) === expected) return;
      yield* Effect.yieldNow;
    }
    throw new Error(`Subscriber count did not reach ${expected}.`);
  });

it.effect("refuses a tool approval when no app window can ask the person", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const outcome = yield* browserBridge.requestToolApproval({
      tool: "site_publish",
      title: "Publish a site",
      sensitive: true,
    });
    assert.equal(outcome, "no_client");
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

it.effect("asks the person for a tool approval and returns their answer", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const eventFiber = yield* browserBridge.stream.pipe(
      Stream.runHead,
      Effect.map((option) => Option.getOrThrow(option)),
      Effect.forkScoped,
    );
    yield* waitForSubscribers(1);
    const approvalFiber = yield* browserBridge
      .requestToolApproval(
        { tool: "app_show_on_internet", title: "Show Notes on the internet", sensitive: true },
        { threadId: "thread-1" },
      )
      .pipe(Effect.forkScoped);
    const event = yield* Fiber.join(eventFiber);
    assert.equal(event.type, "toolApprovalRequest");
    if (event.type !== "toolApprovalRequest") throw new Error("Expected an approval event.");
    assert.equal(event.title, "Show Notes on the internet");
    assert.equal(event.context?.threadId, "thread-1");

    const forged = yield* browserBridge.completeToolApproval({
      requestId: event.requestId,
      responseToken: "wrong",
      approved: true,
    });
    assert.isFalse(forged);
    const accepted = yield* browserBridge.completeToolApproval({
      requestId: event.requestId,
      responseToken: event.responseToken,
      approved: false,
    });
    assert.isTrue(accepted);
    assert.equal(yield* Fiber.join(approvalFiber), "denied");
  }).pipe(Effect.provide(BrowserBridgeTest)),
);

it.effect("times out a tool approval nobody answers", () =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    yield* browserBridge.stream.pipe(Stream.runDrain, Effect.forkScoped);
    yield* waitForSubscribers(1);
    const approvalFiber = yield* browserBridge
      .requestToolApproval({
        tool: "app_remove",
        title: "Remove Notes",
        sensitive: true,
        timeoutMs: 1_000,
      })
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    assert.equal(yield* Fiber.join(approvalFiber), "timeout");
  }).pipe(Effect.provide(BrowserBridgeTest)),
);
