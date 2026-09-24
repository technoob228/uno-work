import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { chromium } from "playwright-core";

import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";

import { BROWSER_SETUP_REQUEST_ENV, BROWSER_SETUP_STATUS_ENV } from "./browserSetup.ts";
import type { ServerConfigShape } from "./config.ts";
import { ServerConfig } from "./config.ts";
import {
  parseTrace,
  proxyConfigProblem,
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

it("reads the exit address and country from Cloudflare trace", () => {
  assert.deepEqual(parseTrace("fl=1\nip=203.0.113.7\nloc=NL\n"), {
    ip: "203.0.113.7",
    country: "NL",
  });
  assert.deepEqual(parseTrace("ip=203.0.113.7\nloc=XX\n"), { ip: "203.0.113.7", country: null });
  assert.deepEqual(parseTrace("nothing"), { ip: null, country: null });
});

it("checks the proxy address before the browser restarts", () => {
  assert.isNull(proxyConfigProblem({ server: "http://proxy.example.com:8080" }));
  assert.isNull(proxyConfigProblem({ server: "socks5://10.0.0.1:1080" }));
  assert.include(proxyConfigProblem({ server: "proxy.example.com" }) ?? "", "http://host:port");
  assert.include(
    proxyConfigProblem({ server: "socks5://10.0.0.1:1080", username: "u", password: "p" }) ?? "",
    "SOCKS5",
  );
});

it.live.skipIf(!hasChromium)(
  "live view: fits the page to the panel for the person, copies the selection, keeps the proxy password server-side",
  () =>
    Effect.gen(function* () {
      const serverBrowser = yield* ServerBrowser;
      const context = { threadId: "live-extras" };
      const html = `<title>extras</title><p id="t">copy me please</p><input id="q" value="abcdef">`;
      yield* serverBrowser.execute(
        { command: "navigate", url: `data:text/html,${encodeURIComponent(html)}` },
        context,
      );
      const page = (yield* serverBrowser.live.state).pages.find(
        (candidate) => candidate.context?.threadId === "live-extras",
      )!;

      // Размер меняет только человек; вернул агенту — размер агента.
      const refused = yield* serverBrowser.live.resize(page.pageId, 500, 700).pipe(Effect.flip);
      assert.include(refused.detail, "Take control");
      yield* serverBrowser.live.setControl(page.pageId, "human");
      yield* serverBrowser.live.resize(page.pageId, 500, 700);
      const inner = yield* serverBrowser
        .execute(
          { command: "evaluate", script: "[window.innerWidth, window.innerHeight]" },
          context,
        )
        .pipe(Effect.timeoutOption("50 millis"));
      // evaluate не из «смотреть можно» — агент ждёт; брошенное ожидание не
      // оставляет флаг «агент ждёт» висеть.
      assert.isTrue(inner._tag === "None");
      const afterAbandon = (yield* serverBrowser.live.state).pages.find(
        (candidate) => candidate.pageId === page.pageId,
      )!;
      assert.isFalse(afterAbandon.agentWaiting);
      const resized = (yield* serverBrowser.live.state).pages.find(
        (candidate) => candidate.pageId === page.pageId,
      )!;
      assert.equal(resized.width, 500);
      assert.equal(resized.height, 700);

      // Выделение в поле ввода и на странице.
      yield* serverBrowser.live.input(page.pageId, { type: "mouse", action: "down", x: 1, y: 1 });
      yield* serverBrowser.live.input(page.pageId, { type: "mouse", action: "up", x: 1, y: 1 });
      yield* serverBrowser.live.setControl(page.pageId, "agent");
      yield* serverBrowser.execute(
        {
          command: "evaluate",
          script:
            "(() => { const q = document.querySelector('#q'); q.focus(); q.setSelectionRange(1, 4); return true })()",
        },
        context,
      );
      assert.equal(yield* serverBrowser.live.copySelection(page.pageId), "bcd");
      yield* serverBrowser.execute(
        {
          command: "evaluate",
          script:
            "(() => { document.activeElement.blur(); const r = document.createRange(); r.selectNodeContents(document.querySelector('#t')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true })()",
        },
        context,
      );
      assert.equal(yield* serverBrowser.live.copySelection(page.pageId), "copy me please");
      const back = (yield* serverBrowser.live.state).pages.find(
        (candidate) => candidate.pageId === page.pageId,
      )!;
      assert.equal(back.width, 1280);

      // Прокси: плохой адрес — отказ; хороший — в состоянии без пароля.
      const bad = yield* serverBrowser.live.setProxy({ server: "nope" }).pipe(Effect.flip);
      assert.include(bad.detail, "http://host:port");
      const withProxy = yield* serverBrowser.live.setProxy({
        server: "http://127.0.0.1:9",
        username: "user1",
        password: "s3cret-pass",
      });
      assert.deepEqual(withProxy.location.proxy, {
        server: "http://127.0.0.1:9",
        username: "user1",
      });
      assert.notInclude(JSON.stringify(withProxy), "s3cret-pass");
      assert.equal(withProxy.pages.length, 0);
      const cleared = yield* serverBrowser.live.setProxy({ server: "" });
      assert.isNull(cleared.location.proxy);

      yield* serverBrowser.shutdown;
    }).pipe(Effect.provide(testLayer)),
  120_000,
);

it.live.skipIf(hasChromium)(
  "browser not set up yet: the agent gets 'try again in N s', the person gets the setup tab",
  () => {
    const root = mkdtempSync(join(tmpdir(), "t3-server-browser-setup-"));
    const requestFile = join(root, "browser-setup", "request");
    const saved = {
      request: process.env[BROWSER_SETUP_REQUEST_ENV],
      status: process.env[BROWSER_SETUP_STATUS_ENV],
    };
    process.env[BROWSER_SETUP_REQUEST_ENV] = requestFile;
    process.env[BROWSER_SETUP_STATUS_ENV] = join(root, "status.json");
    const restore = () => {
      for (const [key, value] of [
        [BROWSER_SETUP_REQUEST_ENV, saved.request],
        [BROWSER_SETUP_STATUS_ENV, saved.status],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    const layer = ServerBrowserLive.pipe(
      Layer.provide(
        Layer.succeed(ServerConfig, {
          stateDir: join(root, "userdata"),
        } as ServerConfigShape),
      ),
    );
    return Effect.gen(function* () {
      const serverBrowser = yield* ServerBrowser;
      const result = yield* serverBrowser.execute(
        { command: "openUrl", url: "https://example.com" },
        { threadId: "setup-thread" },
      );
      assert.isFalse(result.ok);
      assert.match(result.error ?? "", /being set up.*Try the same command again in \d+ s/);
      assert.isTrue(existsSync(requestFile));

      const opened = yield* serverBrowser.live.open({ threadId: "setup-thread" }, "");
      assert.equal(opened.pageId, BROWSER_LIVE_SETUP_PAGE_ID);

      const state = yield* serverBrowser.live.state;
      assert.equal(state.setup.status, "installing");
      assert.deepEqual(state.setup.context, { threadId: "setup-thread" });
      assert.equal(state.pages.length, 0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(restore)));
  },
);
