// Apps & sites → Apps as a grid of icons with a search, like Launchpad
// (Misha 28.10, moved onto 0.0.190): the grid, a search, nothing found, the
// hover with ⚙ and Pin, a pinned app, a phone. `?apps=many` gives the
// computer a person's real set of apps (src/demo/demoBrowser.ts).
//
// Usage, on a built demo (demo-e2e/build-demo.sh <dist>):
//   DEMO_DIST=<dist> node demo-e2e/apps-grid-shots.mjs <out-dir>            # after-*
//   DEMO_DIST=<base dist> node demo-e2e/apps-grid-shots.mjs <out-dir> --before
//     (the base: the commit before the grid, with the `?apps=many` demo commit)
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/apps-grid";
const before = process.argv.includes("--before");
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

async function newPage(viewport, mobile = false) {
  const context = await browser.newContext({
    viewport,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));
  return page;
}

/** PNG if it fits in 400 KB, else a JPEG of the same name. */
async function shot(page, name, options = {}) {
  const png = join(out, `${name}.png`);
  await page.screenshot({ path: png, ...options });
  if (statSync(png).size <= MAX_BYTES) {
    say(`${png} (${Math.round(statSync(png).size / 1024)} KB)`);
    return;
  }
  unlinkSync(png);
  for (const quality of [78, 65, 50]) {
    const jpg = join(out, `${name}.jpg`);
    await page.screenshot({ path: jpg, type: "jpeg", quality, ...options });
    if (statSync(jpg).size <= MAX_BYTES || quality === 50) {
      say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
      return;
    }
  }
}

async function hideDemoPanel(page) {
  await page.evaluate(() => {
    // The demo's "what to look at" tab on the page's edge: not part of Work.
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 0 || el.textContent?.trim().toLowerCase() !== "что смотреть")
        continue;
      let node = el;
      while (node && node !== document.body && getComputedStyle(node).position !== "fixed") {
        node = node.parentElement;
      }
      if (node && node !== document.body) node.style.display = "none";
    }
    for (const el of document.querySelectorAll("div")) {
      if (el.textContent?.startsWith("Что смотреть") && el.className.includes("shadow")) {
        el.style.display = "none";
      }
    }
  });
}

async function openApps(page) {
  const params = new URLSearchParams({
    world: "live",
    lc: "off",
    speed: "3",
    panel: "closed",
    apps: "many",
  });
  await page.goto(`${server.url}?${params}#/sites?tab=apps`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByTestId("apps-page").waitFor({ timeout: 60_000 });
  // The apps come from the computer a moment later.
  await page
    .getByText("Финансы", { exact: true })
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => say("!! the demo apps did not show up"));
  await page.waitForTimeout(1500);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") === "apps-search",
  );
  if (!before) say(`${page.viewportSize().width}px: the search has the cursor on open: ${focused}`);
  await dismissBanners(page);
  // Toasts of the demo's start ("Models set for your plans"): not this page.
  for (const close of await page.locator("[data-slot=toast-close]").all()) {
    await close.click({ force: true }).catch(() => undefined);
  }
  await page.waitForTimeout(500);
  // Closing a toast took the cursor: give it back, as the person sees the page.
  if (focused) await page.getByTestId("apps-search").focus();
  await hideDemoPanel(page);
  await page.mouse.move(5, 895);
}

const desk = await newPage({ width: 1440, height: 900 });
await openApps(desk);

if (before) {
  await shot(desk, "before-apps");
  await desk.getByText("Финансы", { exact: true }).first().hover();
  await desk.waitForTimeout(400);
  await shot(desk, "before-hover");
} else {
  await shot(desk, "after-grid");
  say(`tiles in the grid: ${await desk.getByTestId("apps-grid").locator("> li").count()}`);

  const search = desk.getByTestId("apps-search");
  await search.fill("ана");
  await desk.waitForTimeout(400);
  await shot(desk, "after-search");
  say(
    `"ана" finds: ${(await desk.getByTestId("apps-grid").locator("> li").allInnerTexts()).join(" | ")}`,
  );

  await search.fill("zoom");
  await desk.waitForTimeout(400);
  await shot(desk, "after-none");
  await search.press("Escape");
  await desk.waitForTimeout(300);
  say(`after Esc the query is "${await search.inputValue()}"`);

  // Hover: ⚙ on the right, Pin on the left (TileShell, as on Home since 0.0.189).
  const tile = desk.getByTestId("apps-grid").locator("> li", { hasText: "Финансы" }).first();
  await tile.hover();
  await desk.waitForTimeout(400);
  await shot(desk, "after-hover");
  await tile.getByTestId("program-pin").click();
  await desk.waitForTimeout(600);
  await desk.mouse.move(5, 895);
  await desk.waitForTimeout(400);
  say(`pinned: aria-pressed=${await tile.getByTestId("program-pin").getAttribute("aria-pressed")}`);
  await shot(desk, "after-pinned");
}

// A phone.
const phone = await newPage({ width: 390, height: 844 }, true);
await openApps(phone);
await shot(phone, before ? "before-phone" : "after-phone");

await browser.close();
server.close();
writeFileSync(join(out, before ? "before-log.txt" : "after-log.txt"), `${log.join("\n")}\n`);
