// Visual polish (T3 port, 30.10): the same screens of the demo build in the
// light and the dark theme, to compare a branch's look before / after.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/visual-shots.mjs <out-dir>
// Screens: Home, the sidebar (close-up), a chat with an agent turn, a menu,
// a dialog (the command palette), Settings. LOG.txt lists what was found.
// EXTRA_CSS=<file> lays a stylesheet over the build (a variant to decide on,
// without a build of its own); ONLY=home,chat limits the screens.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/visual";
const themes = (process.env.THEMES ?? "light,dark").split(",");
// The demo's chats have fixed ages: one clock for both builds.
const CLOCK = new Date(process.env.CLOCK ?? "2026-10-29T15:00:00Z");
const EXTRA_CSS = process.env.EXTRA_CSS ? readFileSync(process.env.EXTRA_CSS, "utf8") : null;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
mkdirSync(out, { recursive: true });

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "chrome" });
  }
}

const server = await serve();
const browser = await launchBrowser();
const log = [];

async function hideDemoCards(page) {
  await dismissBanners(page);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("div")) {
      const text = el.textContent ?? "";
      if (
        (text.startsWith("Что смотреть") || text.startsWith("What to look at")) &&
        el.className.includes("shadow")
      ) {
        el.style.display = "none";
      }
    }
  });
}

for (const theme of themes) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(CLOCK);
  page.on("pageerror", (error) => log.push(`${theme} pageerror: ${error.message.slice(0, 160)}`));
  const shot = async (name, clip) => {
    await hideDemoCards(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${theme}-${name}.png`), ...(clip ? { clip } : {}) });
    log.push(`${theme} ok ${name}`);
  };
  const step = async (name, fn) => {
    if (ONLY && !ONLY.has(name)) return;
    try {
      await fn();
    } catch (error) {
      log.push(`${theme} FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    }
  };
  // The demo keeps the theme in its own storage: set it the way Settings does.
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("t3code:theme", t);
    } catch {}
  }, theme);

  if (EXTRA_CSS) {
    await page.addInitScript((css) => {
      const add = () => {
        const style = document.createElement("style");
        style.dataset.variant = "";
        style.textContent = css;
        document.head.append(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add);
    }, EXTRA_CSS);
  }
  await openDemo(page, server.url);
  await page.waitForTimeout(1500);

  await step("home", async () => {
    const home = page
      .getByTestId("sidebar-places")
      .getByText("Home", { exact: true })
      .or(page.getByRole("link", { name: "Home" }))
      .first();
    if (await home.isVisible().catch(() => false)) await home.click();
    await page.waitForTimeout(1500);
    await shot("01-home");
  });

  await step("sidebar", async () => {
    for (let i = 0; i < 2; i++) {
      const more = page.getByText(/^Show \d+ more$/).first();
      if (!(await more.isVisible().catch(() => false))) break;
      await more.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    const box = await page.locator("[data-sidebar=sidebar]").first().boundingBox();
    await shot("02-sidebar", box ?? { x: 0, y: 0, width: 320, height: 900 });
    const ages = await page.getByTestId("sidebar-row-age").allTextContents();
    log.push(`${theme}   ages: ${ages.join(" / ") || "(none)"}`);
    const groups = await page.locator("[data-testid^=sidebar-recents-time-]").allTextContents();
    if (groups.length) log.push(`${theme}   groups: ${groups.join(" / ")}`);
  });

  await step("chat", async () => {
    // A chat the agent finished ("Ready") has a whole turn in it.
    const ready = page.locator("[data-testid=sidebar-row-d]", { hasText: "Ready" }).first();
    const row = (await ready.count())
      ? ready
      : page.locator("[data-testid=sidebar-row-d]").first();
    await row.click();
    await page.waitForTimeout(2500);
    await shot("03-chat");
    const turns = await page.locator("[data-timeline-root] *").count();
    log.push(`${theme}   chat: ${new URL(page.url()).hash || new URL(page.url()).pathname} (${turns} nodes)`);
  });

  await step("menu", async () => {
    const triggers = [
      page.getByTestId("sidebar-new-menu"),
      page.getByTestId("sidebar-d-view-trigger"),
      page.getByTestId("sidebar-account"),
    ];
    for (const trigger of triggers) {
      if (await trigger.first().isVisible().catch(() => false)) {
        await trigger.first().click();
        break;
      }
    }
    await page.waitForTimeout(700);
    await shot("04-menu");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  await step("dialog", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(900);
    const dialogOpen = () =>
      page
        .locator("[role=dialog]")
        .first()
        .isVisible()
        .catch(() => false);
    // The search button at the top of the sidebar opens the same palette.
    for (const selector of [
      "[data-sidebar=sidebar] button:has(svg.lucide-search)",
      "[data-sidebar=sidebar] button:has(svg.lucide-folder-plus)",
    ]) {
      if (await dialogOpen()) break;
      const button = page.locator(selector).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(900);
      }
    }
    log.push(`${theme}   dialog open: ${await dialogOpen()}`);
    await shot("05-dialog");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  await step("settings", async () => {
    await page.evaluate(() => {
      location.hash = "#/settings/app/general";
    });
    await page.waitForTimeout(2500);
    await shot("06-settings");
    log.push(`${theme}   settings url: ${page.url().split("/").slice(3).join("/")}`);
  });

  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(out, "LOG.txt"), `${log.join("\n")}\n`);
console.log(log.join("\n"));
