// Needs you (the Pult redo, Misha 13.11) on the assist demo's live world:
// the sidebar's Needs-you place opens the screen — the verdict, Decide
// (a deploy approval, a task's question, two tracker questions), Accept the
// result (before / after), Asked you into a chat, Finished what you asked,
// and what runs without the person. Also the phone width.
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   python3 -m http.server 5791 -d dist-demo &
//   node demo-e2e/needs-you-shots.mjs <out-dir> [base-url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots/needs-you";
const base = process.argv[3] ?? "http://localhost:5791";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
async function run(viewport, prefix) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  const shot = async (name, opts = {}) => {
    const file = join(out, `${prefix}${name}.png`);
    await page.screenshot({ path: file, ...opts });
    console.log(file);
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      console.log(`step ${name} skipped:`, String(error?.message ?? error).split("\n")[0]);
    }
  };
  const dismiss = async () => {
    for (const name of ["Not now", "Got it"]) {
      await page
        .getByRole("button", { name })
        .first()
        .click({ timeout: 1200 })
        .catch(() => {});
    }
  };
  await page.goto(`${base}/?demo=assist`, { waitUntil: "commit", timeout: 180_000 });
  await page.waitForSelector("[data-testid=sidebar-row-d], [data-testid=sidebar-show]", {
    timeout: 180_000,
  });
  await page.waitForTimeout(3000);
  await dismiss();
  if (prefix === "") {
    await step("sidebar", async () => {
      const box = await page.locator("[data-sidebar=sidebar]").first().boundingBox();
      await shot("01-sidebar", { clip: { x: 0, y: 0, width: box?.width ?? 320, height: 320 } });
    });
  }
  const place = page.locator(
    "[data-testid=sidebar-needs-you]:visible, [data-testid=sidebar-rail-needs-you]:visible",
  );
  for (let i = 0; i < 5 && (await place.count()) === 0; i++) {
    // Phone: the sidebar is a sheet — open it first.
    await page
      .locator("[data-testid=sidebar-show]:visible")
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (prefix !== "") await shot("01-sidebar");
  await place.first().click({ timeout: 20_000 });
  await page.waitForSelector("[data-testid=needs-you-verdict]", { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await dismiss();
  console.log("verdict:", await page.locator("[data-testid=needs-you-verdict]").textContent());
  await shot("02-screen");
  await step("full", () => shot("03-screen-full", { fullPage: false }));
  await step("review", async () => {
    await page.locator("[data-testid=needs-you-review] > button").first().click();
    await page.waitForTimeout(800);
    await page.locator("[data-testid=needs-you-review]").first().scrollIntoViewIfNeeded();
    await shot("04-review-open");
  });
  await step("accept", async () => {
    await page.locator("[data-testid=needs-you-accept]").first().click();
    await page.waitForTimeout(600);
    await page.locator("[data-testid=needs-you-verdict]").scrollIntoViewIfNeeded();
    await shot("05-after-accept");
  });
  await step("answer tracker question", async () => {
    await page.getByRole("button", { name: "Yes, from Monday" }).click({ timeout: 5000 });
    await page.waitForTimeout(600);
  });
  await step("quiet", async () => {
    await page.locator("[data-testid=needs-you-quiet] > button").click();
    await page.waitForTimeout(500);
    await page.locator("[data-testid=needs-you-quiet]").scrollIntoViewIfNeeded();
    await shot("06-without-you");
  });
  await page.close();
}
await run({ width: 1280, height: 900 }, "");
await run({ width: 390, height: 844 }, "phone-");
await browser.close();
