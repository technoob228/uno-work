// Loom Work (28.10): Playwright harness for the demo build of the real Work
// web client (`VITE_DEMO=loom`). Serves the build, opens it, and gives flows a
// few helpers. Plain `playwright`, no test runner: `node demo-e2e/run.mjs [flow…]`.
// Chrome runs with fake camera/microphone and an auto-picked screen, so the
// recording is real (MediaRecorder, canvas, worker ticks) without a person.
//
// Browser: Chrome for Testing from PLAYWRIGHT_BROWSERS_PATH if it is whole,
// else the system Chrome (`channel: "chrome"`) — on the Mac the cached one
// is often half-deleted by disk cleanups.
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
export const DIST = resolve(process.env.DEMO_DIST ?? join(here, "../../dist-demo"));
export const SHOTS = resolve(process.env.DEMO_SHOTS ?? join(here, "shots"));

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".md": "text/markdown",
};

/** A static server for the build (SPA: unknown paths get index.html). */
export function serve(dir = DIST, port = 0) {
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`No demo build in ${dir} — run demo-e2e/build-demo.sh first`);
  }
  return new Promise((done) => {
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
      let file = join(dir, path);
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
        const index = join(file, "index.html");
        file = existsSync(index) ? index : join(dir, "index.html");
      }
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    });
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address();
      done({ url: `http://localhost:${actual}/`, close: () => server.close() });
    });
  });
}

function cachedChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return null;
  const app = join(root, "chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app");
  const framework = join(
    app,
    "Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions",
  );
  return existsSync(framework) ? join(app, "Contents/MacOS/Google Chrome for Testing") : null;
}

export const MEDIA_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--auto-select-desktop-capture-source=Entire screen",
  "--enable-features=GetDisplayMediaSetAutoSelectAllScreens",
  "--autoplay-policy=no-user-gesture-required",
];

export async function launch({ extraArgs = [] } = {}) {
  const executablePath = cachedChromium();
  const args = [...MEDIA_ARGS, ...extraArgs];
  // BACKGROUNDING=1: let Chrome throttle hidden pages like it does for people
  // (Playwright turns that off by default).
  const ignoreDefaultArgs = process.env.BACKGROUNDING
    ? [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ]
    : [];
  return chromium.launch(
    executablePath
      ? { executablePath, args, ignoreDefaultArgs }
      : { channel: "chrome", args, ignoreDefaultArgs, headless: process.env.HEADED ? false : true },
  );
}

/** Opens the Loom demo (scenario via `?loom=`) on the pricing chat. */
export async function openDemo(page, baseUrl, { scenario = "normal", speed = 4 } = {}) {
  const params = new URLSearchParams({ loom: scenario, speed: String(speed), panel: "closed" });
  await page.goto(`${baseUrl}?${params}`);
  await page.waitForFunction(() => Boolean(window.__loomDemo), null, { timeout: 30_000 });
  await dismissBanners(page);
  await page.getByTestId("loom-panel-pill").click();
  await page.getByTestId("loom-open-chat").click();
  await page.getByTestId("loom-panel").getByRole("button", { name: "Свернуть" }).click();
  await composer(page).waitFor({ timeout: 20_000 });
  await dismissBanners(page);
}

/** Opens the Loom demo on Home of the same computer (Home's "Show the agent"). */
export async function openDemoHome(page, baseUrl, { scenario = "normal", speed = 4 } = {}) {
  const params = new URLSearchParams({ loom: scenario, speed: String(speed), panel: "closed" });
  await page.goto(`${baseUrl}?${params}`);
  await page.waitForFunction(() => Boolean(window.__loomDemo), null, { timeout: 30_000 });
  await dismissBanners(page);
  await page.getByTestId("loom-panel-pill").click();
  await page.getByTestId("loom-open-home").click();
  await page.getByTestId("loom-panel").getByRole("button", { name: "Свернуть" }).click();
  await page.getByTestId("home-composer").waitFor({ timeout: 20_000 });
  await dismissBanners(page);
}

/** Toasts that cover the page in a screenshot. */
export async function dismissBanners(page) {
  for (const label of ["Later", "Not now", "Dismiss"]) {
    const button = page.getByRole("button", { name: label, exact: true }).first();
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
  }
}

/** Record → options → Start; waits for the bar. `trigger` = the button's test id. */
export async function startRecording(
  page,
  { source = "screen", camera = true, microphone = true, trigger = "record-button" } = {},
) {
  await page.getByTestId(trigger).first().click();
  const popup = page.getByTestId("record-popup");
  await popup.waitFor();
  await page.getByTestId(`record-source-${source}`).click();
  for (const [id, want] of [
    ["record-camera", camera],
    ["record-microphone", microphone],
  ]) {
    const toggle = page.getByTestId(id);
    const on =
      (await toggle.getAttribute("aria-checked")) === "true" ||
      (await toggle.getAttribute("data-checked")) !== null;
    if (on !== want) await toggle.click();
  }
  await page.getByTestId("record-start").click();
  await page
    .locator('[data-testid="recording-bar"][data-phase="recording"]')
    .waitFor({ timeout: 15_000 });
}

export function composer(page) {
  return page.locator('[contenteditable="true"]').last();
}

/** Types in the open chat's composer and sends. */
export async function send(page, text) {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await page.keyboard.press("Enter");
}

/** Waits until the page shows the text (an assistant's reply, a card). */
export async function seeText(page, text, timeout = 20_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
}

export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

/**
 * A flow: `export default flow("name", async ({ page, url, step }) => {...})`.
 * `step("what", fn)` names the part that failed in the report.
 */
export function flow(name, body) {
  return { name, body };
}
