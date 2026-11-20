// Pull request automations (Misha 20.11, wave 0.0.190): "Ask me first" for a
// pull request in a chat, and "a pull request runs in a chat" said at once
// when an assistant is picked, on the assist demo.
//
// Usage, on a built demo (demo-e2e/build-demo.sh <dist>):
//   DEMO_DIST=<after dist>  node demo-e2e/prask-shots.mjs <out-dir>
//   DEMO_DIST=<before dist> node demo-e2e/prask-shots.mjs <out-dir> --before
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/prask";
const before = process.argv.includes("--before");
const prefix = before ? "before" : "after";
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));

/** PNG if it fits in 400 KB, else a JPEG (q 75) of the same name. */
async function shot(name, target = page) {
  const png = join(out, `${prefix}-${name}.png`);
  await target.screenshot({ path: png });
  if (statSync(png).size <= MAX_BYTES) {
    console.log(`${png} (${Math.round(statSync(png).size / 1024)} KB)`);
    return;
  }
  const jpg = join(out, `${prefix}-${name}.jpg`);
  await target.screenshot({ path: jpg, type: "jpeg", quality: 75 });
  unlinkSync(png);
  console.log(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
}

async function hideDemoPanel() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) {
      if (el.textContent?.startsWith("Что смотреть") && el.className.includes("shadow")) {
        el.style.display = "none";
      }
    }
  });
}

async function openAutomations() {
  await page.getByTestId("sidebar-nav-automations").click();
  await page.getByTestId("automations-view").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
}

const dialog = () => page.getByTestId("automation-dialog");

async function newPrDialog() {
  await page.getByTestId("automations-new").click();
  await dialog().waitFor();
  await page.getByTestId("automation-when-event").click();
  await page.getByTestId("automation-source-github").click();
  await page.getByTestId("automation-repo").fill("getuno/api");
  await page.getByTestId("automation-suggestion").filter({ hasText: "Review the PR" }).click();
  await page.getByTestId("automation-name-input").click();
  await page.waitForTimeout(500);
}

try {
  const params = new URLSearchParams({ world: "live", speed: "3", panel: "closed" });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoPanel();

  await openAutomations();
  const bolt = page
    .getByTestId("automation-card")
    .filter({ hasText: "Review PRs in getuno/web" })
    .first();
  await bolt.scrollIntoViewIfNeeded();
  await shot("3-card-pr-on-assistant", bolt);

  // 1: a pull request with an assistant as "Who" (the screen's default).
  await newPrDialog();
  await shot("1-dialog-pr-assistant", dialog());
  const saveOpen = !(await page.getByTestId("automation-save").isDisabled());
  console.log(`Create open with an assistant: ${saveOpen}`);

  // 2: the same in a chat — Ask me first (only after: before, no chat to pick).
  const pick = page.getByTestId("automation-chat-pick");
  if (await pick.count()) {
    const value = await pick.evaluate((element) => element.options[1]?.value ?? "");
    await pick.selectOption(value);
    await page.waitForTimeout(500);
    await shot("2-dialog-pr-chat-ask-on", dialog());
    await page.getByTestId("automation-ask-toggle").uncheck();
    await page.waitForTimeout(300);
    await shot("2b-dialog-pr-chat-ask-off", dialog());
  } else {
    console.log("no chat picker for a pull request");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // 4: Edit on the one set up on Bolt before.
  await bolt.getByTestId("automation-menu").click();
  await page.getByTestId("automation-edit").click();
  await dialog().waitFor();
  await page.waitForTimeout(600);
  await shot("4-edit-pr-on-assistant", dialog());
} finally {
  await browser.close();
  await server.close?.();
}
