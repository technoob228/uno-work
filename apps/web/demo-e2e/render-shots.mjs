// A page and a diagram in the answer, full screen, quote with a comment, in
// both themes, to compare a branch with what came before.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/render-shots.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/render";
const themes = (process.env.THEMES ?? "light,dark").split(",");
const CLOCK = new Date("2026-10-30T07:30:00Z");
mkdirSync(out, { recursive: true });

// A real scale factor: emulated, a sandboxed frame stays at 1x and looks blurred.
const args = ["--force-device-scale-factor=2", "--window-size=1280,860"];

async function launchBrowser() {
  try {
    return await chromium.launch({ args });
  } catch {
    return chromium.launch({ channel: "chrome", args });
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
      if (text.length < 200 && /^(Что смотреть|What to look at)/.test(text.trim())) {
        if (String(el.className).includes("shadow")) el.style.display = "none";
      }
    }
  });
}

for (const theme of themes) {
  const context = await browser.newContext({
    viewport: null,
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
    try {
      await fn();
    } catch (error) {
      log.push(`${theme} FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 220)}`);
      await page.screenshot({ path: join(out, `${theme}-fail-${name}.png`) }).catch(() => {});
    }
  };

  await openDemo(page, server.url);
  await page.waitForTimeout(1500);

  const chat = page.locator("[data-testid=sidebar-row-d]", { hasText: "How October went" }).first();
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
    await page.waitForTimeout(3000);
    await shot("01-answer");
  });

  await step("fullscreen", async () => {
    const open = page.getByRole("button", { name: "Open full screen" }).first();
    if (!(await open.isVisible().catch(() => false))) {
      log.push(`${theme}   no full screen button: this build has no pages`);
      return;
    }
    await open.click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(500);
    await shot("02-fullscreen");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  });

  await step("quote", async () => {
    const reply = page.locator("[data-reply-quote-source]").last();
    if (!(await reply.isVisible().catch(() => false))) {
      log.push(`${theme}   no quote source: this build has no quotes`);
      return;
    }
    await reply.locator("p").first().click({ clickCount: 3 });
    await page.waitForTimeout(800);
    await shot("03-quote-button");
    await page.getByTestId("reply-quote-button").click();
    await page.waitForTimeout(300);
    await page.keyboard.type("Is this for paying customers only?");
    await shot("04-quote-comment");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(500);
    await shot("05-quote-in-composer");
    log.push(
      `${theme}   quotes by the composer: ${await page.getByTestId("composer-quote").count()}`,
    );
    await page.locator("[contenteditable=true]").last().click();
    await page.keyboard.type("And what about the reminder?");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1800);
    await shot("06-quote-sent");
    log.push(
      `${theme}   quotes in the sent message: ${await page.getByTestId("sent-quotes").count()}`,
    );
  });

  await step("panel", async () => {
    await page.goto(`${server.url}?world=live&platform=desktop&speed=3&panel=closed`);
    await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    const again = page.locator("[data-testid=sidebar-row-d]", { hasText: "How October went" });
    for (
      let i = 0;
      i < 3 &&
      !(await again
        .first()
        .isVisible()
        .catch(() => false));
      i++
    ) {
      await page
        .getByText(/^Show \d+ more$/)
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
    await again.first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Panel", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByTestId("panel-launcher-open").first().click();
    await page.waitForTimeout(500);
    await page.getByTestId("panel-launcher-site").click();
    await page.waitForTimeout(1200);
    const address = page.getByPlaceholder("Enter an address or search").last();
    await address.fill(new URL("demo-site/index.html", server.url).href);
    await address.press("Enter");
    await page.waitForTimeout(2000);
    const site = page
      .frames()
      .filter((frame) => frame.url().includes("demo-site/index"))
      .pop();
    await site.locator("h1").first().click({ clickCount: 3, timeout: 4000 });
    await page.waitForTimeout(900);
    await shot("07-panel-selected");
    const quote = page.getByTestId("browser-quote-button");
    if ((await quote.count()) === 0) {
      log.push(`${theme}   no quote on the page: this build has no quotes`);
      return;
    }
    await quote.click();
    await page.waitForTimeout(300);
    await page.keyboard.type("Make this shorter");
    await shot("08-panel-comment");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(500);
    await shot("09-panel-in-composer");
  });
  await context.close();
}

writeFileSync(join(out, "log.txt"), `${log.join("\n")}\n`);
console.log(log.join("\n"));
await browser.close();
await server.close?.();
process.exit(0);
