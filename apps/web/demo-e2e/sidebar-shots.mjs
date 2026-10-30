// T3 port S3 (29.10): the sidebar's chat ages (30.10, were time groups), the Undo note, the chat
// header without </> and the composer without Build/Plan, on the demo.
// The clock is fixed to Wed 4 Nov 2026 01:00 so the demo's chats read ages
// from minutes to days. Usage:
//   npx vite --port 5747 &   # in apps/web
//   node demo-e2e/sidebar-shots.mjs <out-dir> [base-url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots";
const base = process.argv[3] ?? "http://localhost:5747";
const demo = process.env.DEMO ?? "assist";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.clock.setFixedTime(
  process.env.CLOCK ? new Date(process.env.CLOCK) : new Date(2026, 10, 4, 1, 0),
);

async function shot(name, clip) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
}
async function dismissCards() {
  for (const name of ["Not now", "Got it", "Skip"]) {
    await page
      .getByRole("button", { name })
      .first()
      .click({ timeout: 1500 })
      .catch(() => {});
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) {
      if (el.textContent?.startsWith("Что смотреть") && el.className.includes("shadow")) {
        el.style.display = "none";
      }
    }
  });
}
async function sidebarBox() {
  const box = await page.locator("[data-sidebar=sidebar]").first().boundingBox();
  return box ?? { x: 0, y: 0, width: 320, height: 860 };
}

await page.goto(`${base}/?demo=${demo}`, { waitUntil: "commit", timeout: 180_000 });
await page.waitForSelector("[data-testid=sidebar-row-age]", { timeout: 180_000 });
await page.waitForTimeout(1500);
await dismissCards();
// Open every "Show N more" so the older chats are on screen too.
for (let i = 0; i < 3; i++) {
  const more = page.getByText(/^Show \d+ more$/).first();
  if (!(await more.isVisible().catch(() => false))) break;
  await more.click().catch(() => {});
  await page.waitForTimeout(300);
}
const labels = await page.locator("[data-testid=sidebar-row-age]").allTextContents();
console.log("ages:", labels.join(" / "));
await shot("01-recents-ages", await sidebarBox());
await page
  .locator("[data-testid=sidebar-row-age]")
  .last()
  .scrollIntoViewIfNeeded()
  .catch(() => {});
await shot("02-recents-older", await sidebarBox());

// Open the first chat of the list: header and composer.
// A finished chat ("Ready"): its composer is free and it can be made Done.
await page
  .locator("[data-testid=sidebar-row-d]", { hasText: "Ready" })
  .first()
  .click({ timeout: 10_000 });
await page.waitForTimeout(2000);
await dismissCards();
await shot("03-chat-header-no-devmode-toggle", { x: 0, y: 0, width: 1280, height: 120 });
// The composer: the bottom of the chat pane.
const pane = await page
  .locator("[contenteditable=true]")
  .last()
  .boundingBox({ timeout: 3000 })
  .catch(() => null);
await shot(
  "04-composer-no-build-plan",
  pane
    ? {
        x: Math.max(0, pane.x - 40),
        y: Math.max(0, pane.y - 40),
        width: Math.min(900, 1280 - pane.x + 40),
        height: 200,
      }
    : { x: 400, y: 640, width: 880, height: 220 },
);
await shot("05-chat-full");

// Done with ⌘⇧S (or the header's Done), then the Undo note.
await page
  .locator("body")
  .click({ position: { x: 900, y: 300 } })
  .catch(() => {});
const done = page.locator("[data-testid=chat-done-button]");
if (await done.isVisible().catch(() => false)) await done.click();
else await page.keyboard.press("Meta+Shift+S");
await page
  .waitForSelector("[data-testid=sidebar-thread-undo-notice]", { timeout: 5000 })
  .catch(() => console.log("no undo note"));
await page.waitForTimeout(400);
await shot("06-undo-notice", await sidebarBox());
const sb = await sidebarBox();
await shot("07-undo-notice-closeup", {
  x: sb.x,
  y: sb.y + sb.height - 90,
  width: sb.width,
  height: 90,
});
// ⌘Z brings it back.
await page.keyboard.press("Meta+Z");
await page.waitForTimeout(1200);
await shot("08-after-undo", await sidebarBox());

// Settings → Legacy isn't reachable in the demo (settings routes go back to a chat).
await browser.close();
