// Only mine (Misha 20.11): a chat is yours if you started it or wrote in it
// recently; your coordinator is always in view. On the assist demo
// (demo/assist/fixtures.ts): "Pricing FAQ" is a thread the coordinator's
// agent started, the person wrote there ~1 h ago and the agent wrote after
// them; "Pricing page: copy, checkout, launch" is the person's coordinator,
// where agents talk. Run it on two builds for before / after: the after one
// keeps both in Only mine.
// Usage, on a built demo (demo-e2e/build-demo.sh <dir>):
//   python3 -m http.server 5792 -d <dir> &
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright \
//     node demo-e2e/owner-recent-shots.mjs <out-dir> [base-url] [name-prefix]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots/owner-recent";
const base = process.argv[3] ?? "http://localhost:5792";
const prefix = process.argv[4] ?? "";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.DEMO_CHROME ? { executablePath: process.env.DEMO_CHROME } : {}),
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

async function shot(name, clip) {
  const file = join(out, `${prefix}${name}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 75, ...(clip ? { clip } : {}) });
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
async function rows() {
  return page
    .locator("[data-testid=sidebar-row-d]")
    .evaluateAll((els) =>
      els.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 70)),
    );
}

await page.goto(`${base}/?demo=assist`, { waitUntil: "commit", timeout: 180_000 });
await page.waitForSelector("[data-testid=sidebar-row-d]", { timeout: 180_000 });
await page.waitForTimeout(2500);
await dismissCards();
await page.mouse.move(1270, 10);

const listed = await rows();
console.log("sidebar (Only mine):\n  " + listed.join("\n  "));
for (const title of ["Pricing FAQ", "Pricing page: copy"]) {
  console.log(`${title}: ${listed.some((row) => row.includes(title)) ? "in view" : "HIDDEN"}`);
}
const hidden = await page
  .getByText(/agent chats? hidden/)
  .first()
  .textContent({ timeout: 1000 })
  .catch(() => null);
console.log("hidden line:", hidden);
await shot("sidebar-only-mine", await sidebarBox());

await browser.close();
