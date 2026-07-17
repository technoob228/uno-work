import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
