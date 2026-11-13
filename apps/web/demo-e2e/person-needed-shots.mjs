// Ready / Needs you only when the person is really needed (Misha 13.11), on the
// assist demo's live world (demo/assist/fixtures.ts, PERSON_NEEDED_CHATS):
// w-launch waits on its agents (bot icon, hidden by Only mine), w-stripe is
// called in ("Needs you" + an Inbox item with the reason), w-backup is Ready by
// the safety net (its helper is done). Usage, on a built demo
// (demo-e2e/build-demo.sh):
//   python3 -m http.server 5791 -d dist-demo &
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright \
//     node demo-e2e/person-needed-shots.mjs <out-dir> [base-url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots/person-needed";
const base = process.argv[3] ?? "http://localhost:5791";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

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
      .click({ timeout: 1200 })
      .catch(() => {});
  }
}
async function sidebarBox() {
  const box = await page.locator("[data-sidebar=sidebar]").first().boundingBox();
  return box ?? { x: 0, y: 0, width: 320, height: 860 };
}
async function load() {
  await page.goto(`${base}/?demo=assist`, { waitUntil: "commit", timeout: 180_000 });
  await page.waitForSelector("[data-testid=sidebar-row-d]", { timeout: 180_000 });
  await page.waitForTimeout(2500);
  await dismissCards();
}
async function rows() {
  return page.locator("[data-testid=sidebar-row-d]").evaluateAll((els) =>
    els.map((el) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
      const bot = el.querySelector("[data-testid=sidebar-row-agent-led]") ? " [agent leads]" : "";
      return text + bot;
    }),
  );
}

// 1. Only mine on — the default now.
await load();
console.log("only mine on:\n  " + (await rows()).join("\n  "));
await shot("01-only-mine-on", await sidebarBox());

// 2. The "Needs you" row, close up.
const called = page.locator("[data-testid=sidebar-row-d]", {
  has: page.locator("[data-testid=sidebar-row-called]"),
});
if ((await called.count()) > 0) {
  // No hover: the row's actions would cover the mark.
  await page.mouse.move(1000, 800);
  await page.waitForTimeout(400);
  const box = await called.first().boundingBox();
  if (box) {
    await shot("02-needs-you-row", {
      x: 0,
      y: Math.max(0, box.y - 60),
      width: Math.max(360, box.x + box.width + 8),
      height: box.height + 120,
    });
  }
} else {
  console.log("no Needs you row");
}

// 3. The Inbox with the call item.
const inbox = page.locator("[data-testid=sidebar-inbox]").first();
if (await inbox.isVisible().catch(() => false)) {
  await inbox.click();
} else {
  await page
    .getByRole("button", { name: /Needs you|Inbox/ })
    .first()
    .click()
    .catch(() => {});
}
await page.waitForTimeout(1500);
await shot("03-inbox-call");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 4. Only mine off: the chats agents lead, with the bot icon.
// The demo resets storage on boot: switch it off the way a person does, with
// "N agent chats hidden · Show" under the list.
await page
  .locator("[data-testid=sidebar-d-hidden-agent-chats]")
  .getByRole("button", { name: "Show" })
  .click({ timeout: 10_000 });
await page.waitForTimeout(1200);
console.log("only mine off:\n  " + (await rows()).join("\n  "));
await shot("04-only-mine-off", await sidebarBox());
const led = page.locator("[data-testid=sidebar-row-d]", {
  has: page.locator("[data-testid=sidebar-row-agent-led]"),
});
if ((await led.count()) > 0) {
  await led.first().scrollIntoViewIfNeeded();
  const box = await led.first().boundingBox();
  if (box) {
    await shot("05-agent-led-row", {
      x: 0,
      y: Math.max(0, box.y - 60),
      width: Math.max(360, box.x + box.width + 8),
      height: box.height + 120,
    });
  }
}

// 5. The person's chat where agents talk: the strip above the composer.
await page
  .locator("[data-testid=sidebar-row-d]", { hasText: "Pricing page" })
  .first()
  .click({ timeout: 10_000 });
await page.waitForTimeout(2500);
await dismissCards();
const bar = await page
  .locator("[data-testid=thread-control-bar]")
  .first()
  .textContent()
  .catch(() => null);
console.log("control bar:", bar);
await shot("06-agents-talking-strip");

// 6. The safety net: Ready after the helper is done.
await page
  .locator("[data-testid=sidebar-row-d]", { hasText: "Nightly backups" })
  .first()
  .click({ timeout: 10_000 })
  .catch(() => console.log("no backups row"));
await page.waitForTimeout(2000);
await shot("07-safety-net-ready");

await browser.close();
