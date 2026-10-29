// The chat feed's showcase (T3 port S4, 29.10): opens the two showcase chats
// of the demo (src/demo/timelineShowcase.ts) on a running dev server and
// shoots them. Usage:
//   npx vite --port 5746 &   # in apps/web
//   node demo-e2e/timeline-shots.mjs <out-dir> <prefix> [base-url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots";
const prefix = process.argv[3] ?? "shot";
const base = process.argv[4] ?? "http://localhost:5746";
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

const TITLES = {
  "showcase-done": "Signup form doesn",
  "showcase-live": "Thank-you page after",
};
let booted = false;
async function open(threadId) {
  if (!booted) {
    await page.goto(`${base}/env-demo-macbook/${threadId}?demo=w0138`, {
      waitUntil: "commit",
      timeout: 180_000,
    });
    await page.waitForSelector("[data-timeline-root]", { timeout: 180_000 });
    booted = true;
    // The demo's "what to look at" card and the notifications ask cover the feed.
    await page
      .getByRole("button", { name: "Not now" })
      .click({ timeout: 3000 })
      .catch(() => {});
  }
  // The demo opens its own chat at start: pick ours from the sidebar.
  await page.getByText(TITLES[threadId]).first().click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) {
      if (el.textContent?.startsWith("Что смотреть") && el.className.includes("shadow")) {
        el.style.display = "none";
      }
    }
  });
}
async function shot(name) {
  if (only && !only.has(name)) return;
  const file = join(out, `${prefix}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}

const steps = {
  async done() {
    await open("showcase-done");
    await shot("done");
  },
  async doneExpanded() {
    await open("showcase-done");
    const fold = page.locator("[data-testid=turn-fold] button").first();
    if (await fold.count()) await fold.click();
    await page.waitForTimeout(400);
    const group = page.locator("[data-testid=work-group-summary]").first();
    if (await group.count()) await group.click();
    await page.waitForTimeout(600);
    await shot("done-expanded");
  },
  async live() {
    await open("showcase-live");
    await shot("live");
  },
  async queue() {
    await open("showcase-live");
    const editor = page
      .locator("[data-testid=composer-editor] [contenteditable=true], [contenteditable=true]")
      .first();
    await editor.click();
    await page.keyboard.type("Also make the button say “Back to the blog”.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    await shot("queue-after-enter");
  },
};

for (const name of (process.env.STEPS ?? "done,doneExpanded,live,queue").split(",")) {
  try {
    await steps[name]();
  } catch (error) {
    console.log(`step ${name} failed:`, error.message);
  }
}
await browser.close();
