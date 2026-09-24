import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { chromium } from "playwright-core";

import type { ServerConfigShape } from "./config.ts";
import { ServerConfig } from "./config.ts";
import {
  SERVER_BROWSER_EXECUTABLE_ENV,
  ServerBrowser,
  ServerBrowserLive,
} from "./serverBrowser.ts";

/**
 * Интеграционный тест с реальным headless Chromium. Пропускается, когда
 * бинарника нет: поставь `npx playwright install chromium` или укажи
 * UNO_WORK_BROWSER_EXECUTABLE.
 */
function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env[SERVER_BROWSER_EXECUTABLE_ENV]?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  try {
    const registryPath = chromium.executablePath();
    return registryPath && existsSync(registryPath) ? registryPath : undefined;
  } catch {
    return undefined;
  }
}

const hasChromium = resolveChromiumExecutable() !== undefined;

// makeServerBrowser читает только stateDir — остальной конфиг не нужен.
const testConfigLayer = Layer.succeed(ServerConfig, {
  stateDir: mkdtempSync(join(tmpdir(), "t3-server-browser-test-")),
} as ServerConfigShape);

const testLayer = ServerBrowserLive.pipe(Layer.provide(testConfigLayer));

/** Высота PNG из IHDR-чанка (big-endian uint32 на смещении 20). */
function pngHeight(dataUrl: string): number {
  const image = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  return image.readUInt32BE(20);
}

const PAGE_HTML =
  `<title>server-browser-test</title>` +
  `<button onclick="this.textContent='clicked-ok'">Press me</button>` +
  `<input id="q">`;
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

it.live.skipIf(!hasChromium)(
  "drives a real headless page through the bridge command set",
  () =>
    Effect.gen(function* () {
      const serverBrowser = yield* ServerBrowser;
      const context = { cwd: "/tmp/server-browser-test" };

      const navigated = yield* serverBrowser.execute(
        { command: "navigate", url: PAGE_URL },
        context,
      );
      assert.isTrue(navigated.ok, navigated.error);

      const state = yield* serverBrowser.execute({ command: "state" }, context);
      assert.isTrue(state.ok, state.error);
      const stateData = state.data as { url: string; title: string };
      assert.include(stateData.url, "data:text/html");
      assert.equal(stateData.title, "server-browser-test");

      const clicked = yield* serverBrowser.execute(
        { command: "clickText", text: "Press me" },
        context,
      );
      assert.isTrue(clicked.ok, clicked.error);

      const buttonText = yield* serverBrowser.execute(
        { command: "evaluate", script: "document.querySelector('button').textContent" },
        context,
      );
      assert.isTrue(buttonText.ok, buttonText.error);
      assert.equal(buttonText.data, "clicked-ok");

      const typed = yield* serverBrowser.execute(
        { command: "type", selector: "#q", value: "hello" },
        context,
      );
      assert.isTrue(typed.ok, typed.error);

      const inputValue = yield* serverBrowser.execute(
        { command: "evaluate", script: "document.querySelector('#q').value" },
        context,
      );
      assert.equal(inputValue.data, "hello");

      const screenshot = yield* serverBrowser.execute({ command: "screenshot" }, context);
      assert.isTrue(screenshot.ok, screenshot.error);
      const screenshotData = screenshot.data as { dataUrl: string };
      assert.match(screenshotData.dataUrl, /^data:image\/png;base64,/);

      // fullPage: на странице выше вьюпорта полный снимок должен быть выше.
      const tallPage = `data:text/html,${encodeURIComponent(
        `<body style="margin:0"><div style="height:3000px">tall</div></body>`,
      )}`;
      yield* serverBrowser.execute({ command: "navigate", url: tallPage }, context);
      const viewportShot = yield* serverBrowser.execute({ command: "screenshot" }, context);
      const fullPageShot = yield* serverBrowser.execute(
        { command: "screenshot", fullPage: true },
        context,
      );
      assert.isTrue(fullPageShot.ok, fullPageShot.error);
      const viewportHeight = pngHeight((viewportShot.data as { dataUrl: string }).dataUrl);
      const fullPageHeight = pngHeight((fullPageShot.data as { dataUrl: string }).dataUrl);
      assert.equal(viewportHeight, 800);
      assert.isAbove(fullPageHeight, 2000);

      yield* serverBrowser.shutdown;
    }).pipe(Effect.provide(testLayer)),
  120_000,
);

it.live.skipIf(!hasChromium)(
  "live view: frames, the person takes control, the agent waits and asks for help",
  () =>
    Effect.gen(function* () {
      const serverBrowser = yield* ServerBrowser;
      const context = { threadId: "live-thread", cwd: "/tmp/server-browser-live" };

      yield* serverBrowser.execute({ command: "navigate", url: PAGE_URL }, context);
      const state = yield* serverBrowser.live.state;
      const page = state.pages.find((candidate) => candidate.context?.threadId === "live-thread");
      assert.isDefined(page);
      const pageId = page!.pageId;
      assert.equal(page!.control, "agent");
      assert.isAbove(page!.attention, 0);

      // Кадр приходит, пока кто-то смотрит.
      const frame = yield* serverBrowser.live.frames(pageId).pipe(Stream.runHead);
      assert.isTrue(Option.isSome(frame));
      const firstFrame = Option.getOrThrow(frame);
      assert.isAbove(firstFrame.data.length, 100);
      assert.equal(firstFrame.width, 1280);

      // Ввод без взятия управления — отказ.
      const refused = yield* serverBrowser.live
        .input(pageId, { type: "text", text: "x" })
        .pipe(Effect.flip);
      assert.include(refused.detail, "Take control");

      // Человек взял управление: печатает в поле, агент ждёт и получает отказ.
      yield* serverBrowser.live.setControl(pageId, "human");
      const blocked = yield* serverBrowser.execute(
        { command: "clickText", text: "Press me", timeoutMs: 300 },
        context,
      );
      assert.isFalse(blocked.ok);
      assert.include(blocked.error ?? "", "taken control");
      // Смотреть агенту можно и сейчас.
      const observed = yield* serverBrowser.execute({ command: "state" }, context);
      assert.isTrue(observed.ok, observed.error);

      yield* serverBrowser.live.input(pageId, { type: "mouse", action: "down", x: 5, y: 5 });
      yield* serverBrowser.live.input(pageId, { type: "mouse", action: "up", x: 5, y: 5 });

      // Агент просит помощи и ждёт; человек отдаёт браузер — запрос завершается.
      const help = yield* serverBrowser
        .execute({ command: "requestHelp", text: "Solve the captcha", timeoutMs: 20_000 }, context)
        .pipe(Effect.forkChild);
      let asked = false;
      for (let i = 0; i < 200 && !asked; i++) {
        const current = yield* serverBrowser.live.state;
        asked =
          current.pages.find((candidate) => candidate.pageId === pageId)?.help?.reason ===
          "Solve the captcha";
        if (!asked) yield* Effect.sleep("20 millis");
      }
      assert.isTrue(asked);
      yield* serverBrowser.live.setControl(pageId, "agent");
      const helpResult = yield* Fiber.join(help);
      assert.isTrue(helpResult.ok, helpResult.error);
      assert.deepInclude(helpResult.data as object, { handedBack: true });
      const after = yield* serverBrowser.live.state;
      assert.isNull(after.pages.find((candidate) => candidate.pageId === pageId)?.help);

      // Управление снова у агента — команда проходит.
      const clicked = yield* serverBrowser.execute(
        { command: "clickText", text: "Press me" },
        context,
      );
      assert.isTrue(clicked.ok, clicked.error);

      yield* serverBrowser.shutdown;
    }).pipe(Effect.provide(testLayer)),
  120_000,
);
