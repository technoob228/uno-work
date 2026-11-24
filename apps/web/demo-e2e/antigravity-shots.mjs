// Antigravity (T66, 24.11): Settings → AI, the sign-in window up to Google's
// link, signed in, and the setup's AI step, on the demo build (1440 wide).
//   demo-e2e/build-demo.sh && node demo-e2e/antigravity-shots.mjs <out-dir> [prefix]
// With DEMO_DIST pointing at an older build it shoots the "before" screens.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/antigravity";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
const log = [];
const WORLD = { world: "new", plans: "signin", lc: "fresh" };

async function hideDemoTab(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div,button")) {
      const text = (el.textContent ?? "").trim();
      if (/^(Что смотреть|What to look at)$/.test(text) && String(el.className).includes("shadow"))
        el.style.display = "none";
    }
  });
}

async function run(name, body) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const shot = async (label, locator) => {
    await page.waitForTimeout(600);
    await hideDemoTab(page);
    const path = join(out, `${prefix}-${name}${label ? `-${label}` : ""}.jpg`);
    if (locator) await locator.screenshot({ path, type: "jpeg", quality: 78 });
    else await page.screenshot({ path, type: "jpeg", quality: 78 });
  };
  try {
    const params = new URLSearchParams({ world: "live", ...WORLD, speed: "3", panel: "closed" });
    await page.goto(`${server.url}?${params}`);
    await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
    await page.waitForTimeout(2500);
    await dismissBanners(page);
    await body({ page, shot });
    log.push(`ok   ${name}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await page.screenshot({ path: join(out, `${prefix}-${name}-failed.jpg`), type: "jpeg" });
  }
  await context.close();
}

const go = (page, path, search = {}) =>
  page.evaluate(([to, params]) => window.__assistDemo.go(to, params), [path, search]);

await run("settings", async ({ page, shot }) => {
  await go(page, "/settings/ai");
  await page.getByText("AGENTS", { exact: false }).first().waitFor();
  await page.getByText("Grok", { exact: true }).first().scrollIntoViewIfNeeded();
  await shot("");
  if (prefix === "before") return;
  await page.getByTestId("agent-setup-antigravity").click();
  await page.waitForTimeout(500);
  await shot("signin-choice");
  await page.getByTestId("harness-sign-in-account").first().click();
  await page.getByTestId("harness-sign-in-link").first().waitFor();
  await page.getByTestId("harness-sign-in-code").first().waitFor();
  await shot("signin-google-link");
  // The demo's sign-in finishes by itself after a few polls.
  await page.getByText("Sign out", { exact: true }).first().waitFor({ timeout: 30_000 });
  await shot("signed-in");
});

await run("setup-ai", async ({ page, shot }) => {
  await go(page, "/setup", { step: "ai" });
  await page.getByText("Gemini", { exact: false }).first().waitFor();
  await shot("");
});

console.log(log.join("\n"));
await browser.close();
server.close();
