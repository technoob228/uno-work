// T52 (Misha 20.11): "Waiting for you · 3" in a long coordinator chat, on the
// assist demo. The chat and its cards: src/demo/pendingTrayDemo.ts.
//
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   node demo-e2e/pending-tray-shots.mjs <out-dir>
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DIST, dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/pending-tray";
const only = process.argv[3] ?? "all";
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

/** JPEG under 400 KB (quality steps down if needed). */
async function shot(page, name, options = {}) {
  for (const quality of [86, 78, 70, 60]) {
    const jpg = join(out, `${name}.jpg`);
    await page.screenshot({ path: jpg, type: "jpeg", quality, ...options });
    if (statSync(jpg).size <= MAX_BYTES) {
      say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB, q${quality})`);
      return;
    }
    unlinkSync(jpg);
  }
  throw new Error(`${name}: over 400 KB`);
}

async function hideDemoPanel(page) {
  await page.evaluate(() => {
    // The demo's "what to look at" tab and card: not part of Work.
    for (const el of document.querySelectorAll("body *")) {
      if (
        !/смотреть/i.test(el.textContent ?? "") &&
        !/смотреть/i.test(el.getAttribute("aria-label") ?? "")
      )
        continue;
      let node = el;
      while (node && node !== document.body && getComputedStyle(node).position !== "fixed") {
        node = node.parentElement;
      }
      if (node && node !== document.body) node.style.display = "none";
    }
  });
}

async function newPage(width, height, extra = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}),
  });
  // The banners "published" on uno4.me: answered from the demo's files.
  await context.route(/^https:\/\/launch-banner-(a|b)\.uno4\.me\//, async (route) => {
    const which = route.request().url().includes("banner-a") ? "a" : "b";
    await route.fulfill({
      contentType: "text/html",
      body: readFileSync(join(DIST, "demo-site", `banner-${which}.html`), "utf8"),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));
  const params = new URLSearchParams({
    world: "live",
    lc: "off",
    speed: "3",
    panel: "closed",
    ...extra,
  });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  // T50's chat requests from the cloud: another story, out of the sidebar.
  await page.evaluate(() => window.__chatRequestsDemo?.hold());
  await page.waitForTimeout(6500);
  await dismissBanners(page);
  await hideDemoPanel(page);
  return page;
}

async function openLaunchChat(page) {
  await page.evaluate(() => {
    location.hash = `#/${window.__assistDemo.environmentOf("work")}/w-t52-launch`;
  });
  await page.waitForTimeout(3500);
  await dismissBanners(page);
  await hideDemoPanel(page);
  // The cards measure themselves after the first paint: settle at the end.
  for (let i = 0; i < 3; i += 1) {
    const toEnd = page.getByRole("button", { name: "Scroll to end" });
    if (!(await toEnd.isVisible().catch(() => false))) break;
    await toEnd.click();
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
}

const strip = (page) => page.getByTestId("pending-for-you");
const count = async (page) =>
  (await page
    .getByTestId("pending-for-you-count")
    .textContent()
    .catch(() => null)) ?? "none";

async function rowTitles(page) {
  return page
    .getByTestId("pending-for-you-row")
    .evaluateAll((rows) => rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim()));
}

// ── Before: the same chat, no strip (?tray=off) ──
if (only === "all" || only === "before") {
  const page = await newPage(1440, 900, { tray: "off" });
  await openLaunchChat(page);
  await shot(page, "before-1440");
  say(
    `before: strip shown? ${await strip(page)
      .isVisible()
      .catch(() => false)}`,
  );
  // Scroll up to the buried pricing card.
  await page.context().close();
}

// ── After, 1440 ──
if (only === "all" || only === "after") {
  const page = await newPage(1440, 900);
  await openLaunchChat(page);
  await strip(page).waitFor({ timeout: 15_000 });
  say(`after: count ${await count(page)}; rows ${JSON.stringify(await rowTitles(page))}`);
  await shot(page, "after-1-strip");

  // The older pricing card, far up: "Replaced by a newer card below".
  const scroller = page.locator("[data-timeline-root]").first();
  await scroller.hover();
  let found = false;
  for (let i = 0; i < 40 && !found; i += 1) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(250);
    found = await page
      .locator("[data-pending-mark=replaced]")
      .isVisible()
      .catch(() => false);
  }
  if (found) {
    await page
      .locator("[data-pending-mark=replaced]")
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(600);
    await page.mouse.move(5, 5);
    await shot(page, "after-1b-replaced");
  }
  say(`replaced card found: ${found}`);
  // Back at the end, where the person reads.
  for (let i = 0; i < 4; i += 1) {
    const toEnd = page.getByRole("button", { name: "Scroll to end" });
    if (!(await toEnd.isVisible().catch(() => false))) break;
    await toEnd.click();
    await page.waitForTimeout(700);
  }

  // Jump to the pricing card (hidden in the agents' talk): it opens and lights.
  await page
    .getByTestId("pending-for-you-row")
    .filter({ hasText: "Pricing" })
    .getByTestId("pending-for-you-show")
    .click();
  await page
    .locator("[data-highlighted=true]")
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  say(
    `jump: highlighted ${await page
      .locator("[data-highlighted=true]")
      .getAttribute("data-timeline-row-id")
      .catch(() => "none")}`,
  );
  await shot(page, "after-2-jump");

  // Answer the card: "Go with $12" (the newer pricing card's frame).
  let pressed = false;
  for (let attempt = 0; attempt < 20 && !pressed; attempt += 1) {
    if (attempt > 0) await page.waitForTimeout(400);
    // The card's page loads when its row is on screen: jump to it again.
    if (attempt === 8) {
      await page
        .getByTestId("pending-for-you-row")
        .filter({ hasText: "Pricing" })
        .getByTestId("pending-for-you-show")
        .click();
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      // The page sits in a frame inside the frame: the inner one has the buttons.
      const button = frame.locator("button", { hasText: "Go with $12" });
      if ((await button.count().catch(() => 0)) === 0) continue;
      if (!(await frame.content()).includes("Lovable")) continue;
      await button.first().click();
      pressed = true;
      break;
    }
  }
  say(`pressed Go with $12: ${pressed} (frames: ${page.frames().length})`);
  if (!pressed) {
    for (const frame of page.frames()) {
      say(
        `  frame: ${(await frame.evaluate(() => document.body?.innerText.slice(0, 60)).catch((e) => String(e))) ?? ""}`,
      );
    }
    say(
      `  v2 row in DOM: ${await page.locator("[data-timeline-row-id='html-render:t52-pricing-v2-page'] iframe").count()}`,
    );
  }
  await page.waitForTimeout(4500);
  say(`answered: count ${await count(page)}; rows ${JSON.stringify(await rowTitles(page))}`);
  await page.mouse.move(5, 5);
  await shot(page, "after-3-answered");

  // Not needed: hide the banners row (hover shows the button).
  const bannerRow = page.getByTestId("pending-for-you-row").filter({ hasText: "banners" });
  await bannerRow.getByTestId("pending-for-you-dismiss").hover();
  await page.waitForTimeout(300);
  await shot(page, "after-4-dismiss-hover");
  await bannerRow.getByTestId("pending-for-you-dismiss").click();
  await page.waitForTimeout(600);
  say(`dismissed: count ${await count(page)}; rows ${JSON.stringify(await rowTitles(page))}`);
  await page.mouse.move(5, 5);
  await shot(page, "after-5-dismissed");

  // Back: show again, then fold the strip.
  await page.getByTestId("pending-for-you-restore").click();
  await page.waitForTimeout(400);
  await page.getByTestId("pending-for-you-toggle").click();
  await page.waitForTimeout(400);
  say(`folded: ${await strip(page).getAttribute("data-folded")}; count ${await count(page)}`);
  await page.mouse.move(5, 5);
  await shot(page, "after-6-folded");

  // A link row opens the banner in the panel; the row counts it.
  await page.getByTestId("pending-for-you-toggle").click();
  await page.waitForTimeout(300);
  await page
    .getByTestId("pending-for-you-row")
    .filter({ hasText: "banners" })
    .getByTestId("pending-for-you-open")
    .click();
  await page.waitForTimeout(2500);
  await page.mouse.move(5, 5);
  say(`link opened: rows ${JSON.stringify(await rowTitles(page))}`);
  await shot(page, "after-7-link-panel");
  await page.context().close();
}

// ── 390 wide ──
if (only === "all" || only === "mobile") {
  for (const tray of ["off", "on"]) {
    const page = await newPage(390, 844, tray === "off" ? { tray: "off" } : {});
    await openLaunchChat(page);
    if (tray === "off") {
      await shot(page, "before-390");
    } else {
      await strip(page).waitFor({ timeout: 15_000 });
      // A phone: one line until opened.
      await shot(page, "mobile-1-folded");
      await page.getByTestId("pending-for-you-toggle").click();
      await page.waitForTimeout(400);
      await shot(page, "mobile-2-strip");
      await page
        .getByTestId("pending-for-you-row")
        .filter({ hasText: "Pricing" })
        .getByTestId("pending-for-you-show")
        .click();
      await page
        .locator("[data-highlighted=true]")
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
      await shot(page, "mobile-3-jump");
    }
    await page.context().close();
  }
}

writeFileSync(join(out, "shots-log.txt"), `${log.join("\n")}\n`);
await browser.close();
server.close();
