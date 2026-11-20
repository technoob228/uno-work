// T55 (Misha 20.11): the sidebar and Home from blocks, presets, the look, and
// an agent that makes a sidebar from a chat request — on the assist demo.
//
// Usage, on a built demo (demo-e2e/build-demo.sh <dir>):
//   DEMO_DIST=<base build> node demo-e2e/blocks-layout-shots.mjs <out> --before
//   DEMO_DIST=<this build> node demo-e2e/blocks-layout-shots.mjs <out>
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openMainChat, send, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/blocks-layout";
const before = process.argv.includes("--before");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7) ?? null;
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// The demo's "what to look at" pill isn't part of Work.
await context.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "[data-testid=demo-panel-pill]{display:none!important}";
    document.head.append(style);
  });
  // The demo's start note about models is noise in every shot.
  setInterval(() => {
    for (const title of document.querySelectorAll("[data-slot=toast-title]")) {
      if (title.textContent?.includes("Models set for your plans")) {
        const toast = title.closest("[data-slot=toast-viewport] > *") ?? title.parentElement?.parentElement?.parentElement;
        if (toast) toast.style.display = "none";
      }
    }
  }, 100);
});
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));

/** JPEG, quality down until it fits in 400 KB. */
async function shot(name, options = {}) {
  await hideDemoChrome();
  for (const quality of [88, 80, 72, 64]) {
    const file = join(out, `${name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality, ...options });
    const kb = Math.round(statSync(file).size / 1024);
    if (statSync(file).size <= MAX_BYTES) {
      console.log(`${file} (${kb} KB, q${quality})`);
      return;
    }
    unlinkSync(file);
  }
  throw new Error(`${name}: over 400 KB`);
}

async function hideDemoChrome() {
  await page.evaluate(() => {
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

/** The "Models set for your plans" note: closed like a person would. */
async function closeModelsNote() {
  const note = page.getByText("Models set for your plans").first();
  if (!(await note.isVisible().catch(() => false))) return;
  const box = await note.boundingBox();
  const buttons = page.locator("button");
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    const b = await buttons.nth(i).boundingBox().catch(() => null);
    if (b && Math.abs(b.y - (box.y - 10)) < 30 && b.x > box.x + 250) {
      await buttons.nth(i).click().catch(() => undefined);
      return;
    }
  }
}

async function open(storage = {}) {
  await page.goto(`${server.url}?world=live&lc=off&speed=3&panel=closed`);
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByTestId("sidebar-account").first().waitFor({ timeout: 60_000 });
  await page.locator("[data-testid=sidebar-row-d]").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  // The cloud chats' requests (another feature's demo) wait in every view: away.
  await page.evaluate(() => window.__chatRequestsDemo?.hold?.());
  await page.waitForTimeout(400);
  await dismissBanners(page);
  await closeModelsNote();
}

/** Scrolls the main area (Home) by `dy`. */
async function scrollMain(dy) {
  await page.evaluate((by) => {
    let node = document.querySelector("[data-testid=home-simple]");
    while (node && !(node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY !== "visible")) {
      node = node.parentElement;
    }
    node?.scrollBy(0, by);
  }, dy);
  await page.waitForTimeout(500);
}

async function go(hash) {
  await page.evaluate((to) => {
    location.hash = to;
  }, hash);
  await page.waitForTimeout(1800);
  await dismissBanners(page);
  await hideDemoChrome();
}

const want = (name) => only === null || name.startsWith(only);

if (before) {
  await open();
  await shot("before-sidebar-home");
  await page.getByText("Customize widgets").first().click().catch(() => undefined);
  await page.waitForTimeout(600);
  await shot("before-home-customize");
  await go("#/settings/general");
  await page.getByText("Theme", { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  await shot("before-settings-theme");
  await browser.close();
  server.close();
  process.exit(0);
}

const ENV_WORK = await (async () => {
  await open();
  return page.evaluate(() => window.__assistDemo.environmentOf("work"));
})();
const pult = `widget:${encodeURIComponent(ENV_WORK)}:${encodeURIComponent("manifest:pult")}`;
const limits = `widget:${encodeURIComponent(ENV_WORK)}:${encodeURIComponent("manifest:ai-limits")}`;
const layout = (blocks, preset = null) =>
  JSON.stringify({ blocks: blocks.map((id) => (typeof id === "string" ? { id } : id)), preset });

// 1. Edit mode from the account menu, then the catalog.
if (want("edit")) {
  await open();
  await page.getByTestId("sidebar-account").first().click();
  await page.waitForTimeout(400);
  await shot("edit-0-menu");
  await page.getByTestId("sidebar-customize").click();
  await page.waitForTimeout(800);
  await shot("edit-1-mode");
  await page.getByTestId("sidebar-add-block").scrollIntoViewIfNeeded();
  await page.getByTestId("sidebar-add-block").click();
  await page.waitForTimeout(700);
  await shot("edit-2-catalog");
  // Add Needs you and Пульт from the catalog: they land above the chats.
  await page.getByTestId("catalog-needs-you").getByRole("button", { name: "Add" }).click();
  await page.getByTestId("catalog-widget-manifest:pult").getByRole("button", { name: "Add" }).click();
  await page.waitForTimeout(800);
  await shot("edit-3-added");
  await page.getByRole("button", { name: "Close" }).first().click();
  await page.waitForTimeout(400);
  await page.getByTestId("sidebar-edit-done").click();
  await page.waitForTimeout(1500);
  await shot("edit-4-done");
}

// 2. The presets.
if (want("preset")) {
  await open({
    "uno-work:layout:sidebar:v1": layout(
      ["places", "needs-you", { id: pult, size: "m" }, "pinned", "assistants", "chats"],
      "founder",
    ),
  });
  await page.waitForTimeout(1500);
  await shot("preset-founder");
  await open({ "uno-work:layout:sidebar:v1": layout(["places", "chats"], "minimal") });
  await shot("preset-minimal");
  await open({
    "uno-work:layout:sidebar:v1": layout(
      ["places", "computers", "apps", "pinned", "chats"],
      "developer",
    ),
  });
  await shot("preset-developer");
}

// 3. A customized Home (same blocks idea, Home's existing Customize).
if (want("home")) {
  await open({
    "uno-work:home:layout:v3": JSON.stringify([
      "greeting",
      "composer",
      "app:pult",
      "app:ai-limits",
      "computer",
      "recent-chats",
    ]),
    "uno-work:home:app-widgets-seen:v1": JSON.stringify(["pult", "ai-limits", "offer-campaign"]),
    "uno-work:home:built-in-widgets-seen:v1": JSON.stringify(["plan-limits"]),
  });
  await page.waitForTimeout(2500);
  await scrollMain(330);
  await shot("home-custom");
  await scrollMain(-1000);
  await page.getByText("Customize widgets").first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await scrollMain(330);
  await shot("home-custom-edit");
}

// 4. The look: accent, tinted sidebar, compact, then dark.
if (want("look")) {
  await open();
  await go("#/settings/general");
  await shot("look-0-default");
  await page.getByRole("radio", { name: "Green" }).click();
  await page.getByRole("radio", { name: "Tinted" }).click();
  await page.waitForTimeout(500);
  await shot("look-1-green-tinted");
  await page.getByRole("radio", { name: "Compact" }).click();
  await page.getByRole("button", { name: /Dark/ }).first().click();
  await page.getByRole("radio", { name: "Amber" }).click();
  await page.waitForTimeout(700);
  await shot("look-2-dark-amber-compact");
  await go("#/");
  await page.waitForTimeout(800);
  await shot("look-3-dark-home");
}

// 5. An agent makes the sidebar from a chat request.
if (want("agent")) {
  await open();
  await openMainChat(page, "work");
  await page.waitForTimeout(1200);
  await send(page, "Сделай мне сайдбар фаундера: сверху что ждёт меня и Пульт, ассистентов убери");
  await page.getByTestId("layout-proposal-card").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.getByTestId("layout-proposal-card").scrollIntoViewIfNeeded();
  await hideDemoChrome();
  await shot("agent-1-proposal");
  await page.getByTestId("layout-proposal-apply").click();
  await page.waitForTimeout(1800);
  await shot("agent-2-applied");
}

await browser.close();
server.close();
