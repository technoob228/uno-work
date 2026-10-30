// Chat cleanup (T3 port, 30.10): an answer naming files every way, a click on
// a chip, search in the panel's Files, in both themes, to compare a branch with
// what came before.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/chatclean-shots.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/chatclean";
const themes = (process.env.THEMES ?? "light,dark").split(",");
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const CLOCK = new Date("2026-10-30T07:30:00Z");
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
    for (const el of document.querySelectorAll("div,button")) {
      const text = el.textContent ?? "";
      if (
        text.length < 200 &&
        (text.startsWith("Что смотреть") ||
          text.startsWith("What to look at") ||
          text.trim() === "Что смотреть")
      ) {
        if (String(el.className).includes("shadow")) el.style.display = "none";
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
  page.on("pageerror", (error) => log.push(`${theme} pageerror: ${error.message.slice(0, 200)}`));
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("t3code:theme", t);
    } catch {}
  }, theme);
  const shot = async (name) => {
    await hideDemoCards(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${theme}-${name}.png`) });
    log.push(`${theme} ok ${name}`);
  };
  const step = async (name, fn) => {
    if (ONLY && !ONLY.has(name)) return;
    try {
      await fn();
    } catch (error) {
      log.push(`${theme} FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 220)}`);
      await page.screenshot({ path: join(out, `${theme}-fail-${name}.png`) }).catch(() => {});
    }
  };

  await openDemo(page, server.url);
  await page.waitForTimeout(1500);

  const chat = page.locator("[data-testid=sidebar-row-d]", { hasText: "Launch report" }).first();
  await step("chat", async () => {
    for (let i = 0; i < 3 && !(await chat.isVisible().catch(() => false)); i++) {
      await page
        .getByText(/^Show \d+ more$/)
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
    await chat.click();
    await page.waitForTimeout(2500);
    await shot("01-chat");
    const chips = await page.getByTestId("chat-file-chip").allTextContents();
    log.push(`${theme}   chips (${chips.length}): ${chips.join(" | ")}`);
  });

  await step("open", async () => {
    await page
      .getByTestId("chat-file-chip")
      .filter({ hasText: "launch-report.md" })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await shot("02-file-open");
    await page.getByTestId("chat-file-chip").filter({ hasText: "docs" }).last().click();
    await page.waitForTimeout(1500);
    await shot("03-folder-open");
  });

  await step("files", async () => {
    await page.getByTestId("sidebar-places").getByRole("button").nth(1).click();
    await page.waitForTimeout(1500);
    await shot("04-files-panel");
  });

  await step("search", async () => {
    const search = page.getByTestId("files-search-input").or(page.getByLabel("Search files"));
    await search.first().fill("report");
    await page.waitForTimeout(1200);
    await shot("05-files-search");
  });

  await step("scrolled", async () => {
    const other = page.locator("[data-testid=sidebar-row-d]", { hasText: "Signup form" }).first();
    await other.click();
    await page.waitForTimeout(2000);
    await shot("06-chat-other");
    const message = page.locator("[data-message-role=user]").last();
    await message.hover({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${theme}-07-user-hover.png`) });
    log.push(`${theme} ok 07-user-hover`);
  });

  await step("feed-end", async () => {
    // A short window: the feed scrolls, and dissolves into the composer.
    await page.setViewportSize({ width: 1440, height: 640 });
    await page.waitForTimeout(800);
    await chat.click();
    await page.waitForTimeout(1800);
    await shot("08-feed-end");
    const box = await page.locator("[data-timeline-root]").first().boundingBox();
    await page.mouse.move(800, (box?.y ?? 100) + 120);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(900);
    await shot("09-scroll-to-end");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(out, "LOG.txt"), `${log.join("\n")}\n`);
console.log(log.join("\n"));
