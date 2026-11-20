// Settings → Security for everyone (Misha 16.10 / 20.11 "without a flag"):
// the entry among the simple settings, Protection on top, and what the page
// says in each state the server can answer (src/demo/assist/securityDemo.ts):
// not on for the account yet (404), on, and after Stop everything & report.
//
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   node demo-e2e/security-shots.mjs <out-dir>            # after-*
//   node demo-e2e/security-shots.mjs <out-dir> --before   # before-* (a base build:
//                                                         # DEMO_DIST=<its dist-demo>)
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/security";
const before = process.argv.includes("--before");
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));

/** JPEG ≤ 400 KB (q 75). */
async function shot(name) {
  await hideDemoPanel();
  const jpg = join(out, `${name}.jpg`);
  await page.screenshot({ path: jpg, type: "jpeg", quality: 75 });
  if (statSync(jpg).size > MAX_BYTES) {
    unlinkSync(jpg);
    await page.screenshot({ path: jpg, type: "jpeg", quality: 60 });
  }
  console.log(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
}

/** The demo's "what to look at" tab and the demo's own toasts: not part of the page. */
async function hideDemoPanel() {
  await page.evaluate(() => {
    const hide = (el) => {
      let node = el;
      while (node && node !== document.body && getComputedStyle(node).position !== "fixed") {
        node = node.parentElement;
      }
      if (node && node !== document.body) node.style.display = "none";
    };
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length > 0) continue;
      const text = el.textContent?.trim().toLowerCase() ?? "";
      if (text === "что смотреть" || text === "models set for your plans") hide(el);
    }
  });
}

async function open(security) {
  const params = new URLSearchParams({ world: "live", lc: "off", speed: "3", panel: "closed" });
  if (security) params.set("security", security);
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoPanel();
}

async function go(hash) {
  await page.evaluate((to) => {
    location.hash = to;
  }, hash);
  await page.waitForTimeout(2200);
  await dismissBanners(page);
  await hideDemoPanel();
}

async function navLabels() {
  return page.evaluate(() =>
    [...document.querySelectorAll("a[href*='/settings/']")]
      .map((a) => a.textContent?.trim())
      .filter(Boolean),
  );
}

if (before) {
  await open(null);
  await go("#/settings/account");
  console.log("nav:", JSON.stringify(await navLabels()));
  await shot("before-settings-nav");
  await go("#/settings/computer");
  await page
    .getByText("Safety and more")
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await page.waitForTimeout(500);
  await shot("before-computer-security-row");
} else {
  // Production today: the server hasn't turned Protection on (404).
  await open("off");
  await go("#/settings/account");
  console.log("nav:", JSON.stringify(await navLabels()));
  await shot("after-1-settings-nav");
  await go("#/settings/security");
  await shot("after-2-security-not-on-yet");
  await go("#/settings/computer");
  await page
    .getByText("Safety and more")
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await page.waitForTimeout(500);
  await shot("after-3-computer-row-not-on");
  // Protection on for the account.
  await open("on");
  await go("#/settings/security");
  await shot("after-4-security-protection-on");
  await go("#/settings/computer");
  await page
    .getByText("Safety and more")
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await page.waitForTimeout(500);
  await shot("after-5-computer-row-on");
  // After Stop everything & report (SECURITY_HOLD).
  await open("hold");
  await go("#/settings/security");
  await shot("after-6-security-after-red-button");
}

await browser.close();
server.close?.();
process.exit(0);
