// The sidebar's project funnel (31.10) in the demo: each step starts on a clean
// browser, checks the behaviour on the real sidebar and leaves a screenshot.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/funnel-shots.mjs <out-dir> [before|after]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/funnel";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
const FILTER_KEY = "uno-work:sidebar:project-filter";
const LAPTOP = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function step(name, fn, device = LAPTOP) {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    colorScheme: "light",
    ...device,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  const shot = async (label) => {
    await dismissBanners(page);
    await page.screenshot({ path: join(out, `${prefix}-${label}.png`) });
  };
  try {
    if (device === PHONE) {
      // The sidebar is behind its button here: nothing to wait for but the demo.
      await page.goto(`${server.url}?world=live&speed=3&panel=closed`);
      await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      await dismissBanners(page);
    } else {
      await openDemo(page, server.url, {});
    }
    const note = await fn({ page, shot });
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot(`fail-${name}`).catch(() => {});
  }
  await context.close();
}

const title = (page) => page.getByTestId("sidebar-d-view-trigger");
const funnel = (page) => page.getByTestId("sidebar-d-project-filter");
const popup = (page) => page.getByTestId("sidebar-d-project-filter-popup");
const projectRow = (page, name) => page.getByTestId(`sidebar-d-project-filter-${name}`);
const tick = (page, name) => page.getByTestId(`sidebar-d-project-filter-tick-${name}`);
const listRows = (page) => page.getByTestId("sidebar-d-chats").getByTestId("sidebar-row-d");
const rowNames = async (page) =>
  (await listRows(page).locator('[data-testid^="thread-title-"]').allInnerTexts()).map((text) =>
    text.trim(),
  );

async function expectTitle(page, text) {
  const shown = (await title(page).innerText()).trim();
  if (shown !== text) throw new Error(`title "${shown}", wanted "${text}"`);
}

async function group(page, preset) {
  await title(page).click();
  await page.getByTestId(`sidebar-d-preset-${preset}`).click();
  await page.waitForTimeout(300);
}

async function openSidebarOnPhone(page) {
  await page
    .locator('[data-sidebar="trigger"], [aria-label="Toggle Sidebar"], [aria-label="Show sidebar"]')
    .first()
    .click();
  await page.waitForTimeout(800);
}

/** Menu items of the browser's fallback context menu. */
const contextItem = (page, name) => page.getByRole("button", { name, exact: false });

await step(
  "status",
  async ({ page, shot }) => {
    await group(page, "status");
    await shot("status");
  },
  LAPTOP,
);

await step(
  "phone-status",
  async ({ page, shot }) => {
    await openSidebarOnPhone(page);
    await group(page, "status");
    await shot("phone-status");
  },
  PHONE,
);

if (prefix === "after") {
  await step("every-grouping", async ({ page }) => {
    const seen = [];
    for (const preset of ["list", "project", "status", "computer"]) {
      await group(page, preset);
      await funnel(page).click();
      await projectRow(page, "landing").click();
      await expectTitle(page, "Chats · landing");
      seen.push(`${preset}: ${(await rowNames(page)).length}`);
      await page.getByTestId("sidebar-d-clear-filter").click();
      await expectTitle(page, "All chats");
    }
    return seen.join(", ");
  });

  await step("funnel", async ({ page, shot }) => {
    await group(page, "status");
    const before = await rowNames(page);
    await funnel(page).click();
    await popup(page).waitFor();
    await page.waitForTimeout(300);
    await shot("popup");
    await projectRow(page, "landing").click();
    await popup(page).waitFor({ state: "hidden" });
    await expectTitle(page, "Chats · landing");
    await page.mouse.move(700, 500);
    await page.waitForTimeout(300);
    await shot("one");
    const one = await rowNames(page);
    await funnel(page).click();
    await tick(page, "orders-bot").click();
    await expectTitle(page, "Chats · 2 projects");
    if (!(await popup(page).isVisible())) throw new Error("the tick closed the popup");
    await page.waitForTimeout(300);
    await shot("several-popup");
    await page.keyboard.press("Escape");
    await page.mouse.move(700, 500);
    await page.waitForTimeout(300);
    await shot("several");
    return `rows ${before.length} → ${one.length} → ${(await rowNames(page)).length}`;
  });

  await step("menu-sync", async ({ page, shot }) => {
    await funnel(page).click();
    await projectRow(page, "landing").click();
    await title(page).click();
    await page.getByTestId("sidebar-d-pick-project-trigger").hover();
    const landing = page.getByTestId("sidebar-d-pick-project-landing");
    await landing.waitFor();
    if ((await landing.getAttribute("aria-checked")) !== "true") {
      throw new Error("the submenu does not show the funnel's pick");
    }
    await shot("menu-sync");
    await page.getByTestId("sidebar-d-pick-project-orders-bot").click();
    await expectTitle(page, "Chats · 2 projects");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await funnel(page).click();
    const pressed = await tick(page, "orders-bot").getAttribute("aria-pressed");
    if (pressed !== "true") throw new Error("the funnel does not show the submenu's pick");
  });

  await step("context-menu", async ({ page, shot }) => {
    await group(page, "status");
    const row = listRows(page).first();
    await row.click({ button: "right" });
    await page.waitForTimeout(300);
    await shot("context-filter-by");
    const filterBy = contextItem(page, "Filter by");
    const label = (await filterBy.innerText()).trim();
    await filterBy.click();
    await page.waitForTimeout(300);
    const after = (await title(page).innerText()).trim();
    if (!after.startsWith("Chats · ")) throw new Error(`title "${after}"`);
    await listRows(page).first().click({ button: "right" });
    await page.waitForTimeout(300);
    await shot("context-show-all");
    await contextItem(page, "Show all projects").click();
    await page.waitForTimeout(300);
    await expectTitle(page, "All chats");
    return `${label} → ${after}`;
  });

  await step("open-chat-stays", async ({ page, shot }) => {
    await group(page, "status");
    // Open a chat, then filter to a project it is not in.
    await funnel(page).click();
    await projectRow(page, "orders-bot").click();
    const bot = await rowNames(page);
    await page.getByTestId("sidebar-d-clear-filter").click();
    const others = listRows(page).filter({ hasText: bot[0] });
    await others.first().click();
    await page.waitForTimeout(600);
    await funnel(page).click();
    await projectRow(page, "landing").click();
    await page.waitForTimeout(300);
    const kept = await rowNames(page);
    if (!kept.includes(bot[0])) throw new Error(`open chat left the list: ${kept.join(" | ")}`);
    await expectTitle(page, "Chats · landing");
    await page.mouse.move(700, 500);
    await page.waitForTimeout(300);
    await shot("open-chat-stays");
    // Leaving it, the filter holds again.
    await listRows(page).filter({ hasNotText: bot[0] }).first().click();
    await page.waitForTimeout(600);
    const left = await rowNames(page);
    if (left.includes(bot[0])) throw new Error("the chat stayed after leaving it");
    return `"${bot[0]}" kept, gone after leaving`;
  });

  await step("reveal-from-link", async ({ page, shot }) => {
    await group(page, "status");
    await funnel(page).click();
    await projectRow(page, "orders-bot").click();
    const bot = await rowNames(page);
    await page.getByTestId("sidebar-d-clear-filter").click();
    await listRows(page).filter({ hasText: bot[0] }).first().click();
    await page.waitForTimeout(600);
    const link = await page.evaluate(() => location.hash || location.pathname);
    await listRows(page).filter({ hasNotText: bot[0] }).first().click();
    await page.waitForTimeout(600);
    await funnel(page).click();
    await projectRow(page, "landing").click();
    await page.waitForTimeout(300);
    const stored = await page.evaluate((key) => localStorage.getItem(key), FILTER_KEY);
    if ((await rowNames(page)).includes(bot[0])) throw new Error("filter did not hide the chat");
    // A link (⌘K lands on the same route).
    await page.evaluate((to) => {
      location.hash = to;
    }, link);
    await page.waitForTimeout(800);
    const shown = await rowNames(page);
    if (!shown.includes(bot[0]))
      throw new Error(`no row for the opened chat: ${shown.join(" | ")}`);
    const active = await page
      .locator('[data-testid="sidebar-d-chats"] [data-open-chat]')
      .isVisible();
    if (!active) throw new Error("the opened chat's row is not marked as open");
    await expectTitle(page, "Chats · landing");
    const still = await page.evaluate((key) => localStorage.getItem(key), FILTER_KEY);
    if (still !== stored) throw new Error("the reveal rewrote the person's filter");
    await page.mouse.move(700, 500);
    await page.waitForTimeout(300);
    await shot("reveal");
    return `stored ${stored}`;
  });

  await step("reveal-scrolls", async ({ page }) => {
    await group(page, "status");
    await funnel(page).click();
    await projectRow(page, "orders-bot").click();
    const bot = await rowNames(page);
    await page.getByTestId("sidebar-d-clear-filter").click();
    await listRows(page).filter({ hasText: bot[0] }).first().click();
    await page.waitForTimeout(600);
    const link = await page.evaluate(() => location.hash || location.pathname);
    await listRows(page).filter({ hasNotText: bot[0] }).first().click();
    await page.waitForTimeout(600);
    await funnel(page).click();
    await projectRow(page, "landing").click();
    // A short window: the row lands below the fold.
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.waitForTimeout(300);
    await page.evaluate((to) => {
      location.hash = to;
    }, link);
    await page.waitForTimeout(800);
    const box = await page
      .locator('[data-testid="sidebar-d-chats"] [data-open-chat]')
      .boundingBox();
    if (!box || box.y < 0 || box.y + box.height > 480) {
      throw new Error(`row out of view: ${JSON.stringify(box)}`);
    }
    return `row at y=${Math.round(box.y)} of 480`;
  });

  await step("reveal-from-palette", async ({ page }) => {
    await group(page, "status");
    await funnel(page).click();
    await projectRow(page, "orders-bot").click();
    const bot = await rowNames(page);
    await funnel(page).click();
    await projectRow(page, "landing").click();
    await page.waitForTimeout(300);
    if ((await rowNames(page)).includes(bot[0])) throw new Error("filter did not hide the chat");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const input = page.getByRole("dialog").locator("input").first();
    await input.waitFor({ timeout: 3000 });
    await input.fill(bot[0].slice(0, 16));
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    if (!(await rowNames(page)).includes(bot[0])) throw new Error("no row after ⌘K");
    await expectTitle(page, "Chats · landing");
  });

  await step("stored-filter", async ({ page, shot }) => {
    await funnel(page).click();
    await projectRow(page, "landing").click();
    const stored = await page.evaluate((key) => localStorage.getItem(key), FILTER_KEY);
    if (!/^\[".+"\]$/.test(stored ?? "")) throw new Error(`stored as ${stored}`);
    await page.reload();
    await title(page).waitFor();
    await page.waitForTimeout(1500);
    await expectTitle(page, "Chats · landing");
    await page.getByTestId("sidebar-d-clear-filter").click();
    const cleared = await page.evaluate((key) => localStorage.getItem(key), FILTER_KEY);
    await shot("cleared");
    return `${stored} → ${cleared}`;
  });

  await step(
    "phone",
    async ({ page, shot }) => {
      await openSidebarOnPhone(page);
      await group(page, "status");
      await funnel(page).tap();
      await popup(page).waitFor();
      await page.waitForTimeout(400);
      await shot("phone-popup");
      // A tap must not bring the keyboard up over the list.
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      if (focused === "INPUT") throw new Error("the tap focused the search");
      await tick(page, "landing").tap();
      await tick(page, "orders-bot").tap();
      await expectTitle(page, "Chats · 2 projects");
      if (!(await popup(page).isVisible())) throw new Error("the tick closed the popup");
      await page.waitForTimeout(300);
      await shot("phone-several-popup");
      await projectRow(page, "landing").tap();
      await popup(page).waitFor({ state: "hidden" });
      await expectTitle(page, "Chats · landing");
      await page.waitForTimeout(400);
      await shot("phone-one");
      return `focus on open: ${focused}`;
    },
    PHONE,
  );

  await step("rail-panel", async ({ page, shot }) => {
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(500);
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(500);
    const rail = page.getByTestId("sidebar-rail");
    if (!(await rail.isVisible().catch(() => false))) return "no rail in this window: skipped";
    await rail.getByRole("button", { name: "Chats" }).first().click();
    const panel = page.getByTestId("sidebar-chats-panel");
    await panel.waitFor();
    await panel.getByTestId("sidebar-d-project-filter").click();
    await popup(page).waitFor();
    await tick(page, "landing").click();
    await page.waitForTimeout(300);
    if (!(await panel.isVisible())) throw new Error("the tick closed the panel");
    await projectRow(page, "orders-bot").click();
    await page.waitForTimeout(300);
    if (!(await panel.isVisible())) throw new Error("a pick closed the panel");
    await shot("rail-panel");
  });

  await step("flag-off", async ({ page, shot }) => {
    await page.evaluate(() => {
      const key = "t3code:client-settings:v1";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      settings.featureFlags = { ...settings.featureFlags, sidebarViewMenu: false };
      localStorage.setItem(key, JSON.stringify(settings));
    });
    await page.reload();
    await page.getByTestId("sidebar-d-chats-bar").waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    if ((await funnel(page).count()) > 0) throw new Error("a funnel with the flag off");
    await page.getByTestId("sidebar-d-chats").getByTestId("sidebar-row-d").first().click({
      button: "right",
    });
    await page.waitForTimeout(300);
    if ((await contextItem(page, "Filter by").count()) > 0) {
      throw new Error("Filter by with the flag off");
    }
    await shot("flag-off");
  });
}

await browser.close();
server.close();
writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
process.exit(log.some((line) => line.startsWith("FAIL")) ? 1 : 0);
