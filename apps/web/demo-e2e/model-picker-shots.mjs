// T72 (24.11): the composer's model + reasoning picker, cropped to the popup, on two builds.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/model-picker-shots.mjs <out-dir> before|after
// Demo data: the fake daemons' agents and models, not a real account.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/model-picker";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
// plans=both: Claude and Codex on uno-work; plans=signin: agents still to sign in to.
const WORLD = { fleet: "on", pair: "on", plans: "both" };

const POPUP = "[data-slot=popover-popup]";

async function step(name, fn, { width = 1280, scheme = "light", world = WORLD } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  /** The popup and its trigger, with a margin; the whole page when there is no popup. */
  const shot = async (label = "") => {
    const path = join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`);
    const boxes = [];
    for (const selector of [POPUP, "[data-slot=menu-popup]", "[data-chat-provider-model-picker]"]) {
      for (const handle of await page.locator(selector).all()) {
        if (!(await handle.isVisible().catch(() => false))) continue;
        const box = await handle.boundingBox();
        if (box && box.width > 0) boxes.push(box);
      }
    }
    if (boxes.length === 0) return page.screenshot({ path });
    const viewport = page.viewportSize();
    const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 16);
    const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 16);
    const right = Math.min(viewport.width, Math.max(...boxes.map((box) => box.x + box.width)) + 16);
    const bottom = Math.min(
      viewport.height,
      Math.max(...boxes.map((box) => box.y + box.height)) + 16,
    );
    return page.screenshot({
      path,
      clip: { x: left, y: top, width: right - left, height: bottom - top },
    });
  };
  try {
    await openDemo(page, server.url, world);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div,button")) {
        const text = (el.textContent ?? "").trim();
        if (/^(Что смотреть|What to look at)/.test(text) && String(el.className).includes("shadow"))
          el.style.display = "none";
      }
    });
    log.push(`ok ${name}: ${(await fn({ page, shot })) ?? ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("failed").catch(() => undefined);
  }
  await context.close();
}

async function home(page) {
  await page
    .getByRole("link", { name: "Home" })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.getByTestId("home-composer").waitFor();
  await page.waitForTimeout(1200);
}

async function openPicker(page, which = "first") {
  await page.locator("[data-chat-provider-model-picker]")[which]().click();
  await page.locator(POPUP).first().waitFor();
  await page.waitForTimeout(400);
}

/** Picks an agent on the rail, then its first model (or the named one). */
async function pickAgent(page, agent, model) {
  await page
    .locator("[data-model-picker-sidebar]")
    .getByRole("button", { name: agent })
    .first()
    .click();
  await page.waitForTimeout(400);
  const option = model
    ? page.getByRole("option", { name: model }).first()
    : page.getByRole("option").first();
  if (await option.isVisible().catch(() => false)) await option.click();
  await page.waitForTimeout(500);
}

const describe = (page) =>
  page.evaluate((popup) => {
    const el = document.querySelector(popup);
    if (!el) return "no popup";
    const box = el.getBoundingClientRect();
    return `popup ${Math.round(box.width)}x${Math.round(box.height)}`;
  }, POPUP);

await step("closed", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Claude/, /Opus 5\.5/);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await shot();
});

await step("claude", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Claude/, /Opus 5\.5/);
  await page.mouse.move(0, 0);
  await shot();
  return describe(page);
});

await step("claude-context", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Claude/, /Opus 5\.5/);
  const contextRow = page.getByRole("button", { name: /^Context Window/ });
  if (await contextRow.isVisible().catch(() => false)) {
    await contextRow.click();
    await page.waitForTimeout(400);
  }
  await shot();
});

await step("claude-permissions", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Claude/, /Opus 5\.5/);
  await page.getByTestId("model-picker-permissions").click();
  await page.waitForTimeout(400);
  await shot();
});

await step("codex", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Codex/);
  await page.mouse.move(0, 0);
  await shot();
  return describe(page);
});

await step("uno-smart", async ({ page, shot }) => {
  await home(page);
  await openPicker(page);
  await pickAgent(page, /Uno Code/);
  await page.mouse.move(0, 0);
  await shot();
  return describe(page);
});

await step(
  "signin",
  async ({ page, shot }) => {
    await home(page);
    await openPicker(page);
    await pickAgent(page, /Gemini/);
    await page.mouse.move(0, 0);
    await shot();
  },
  { world: { ...WORLD, plans: "signin" } },
);

await step(
  "claude-dark",
  async ({ page, shot }) => {
    await home(page);
    await openPicker(page);
    await pickAgent(page, /Claude/, /Opus 5\.5/);
    await page.mouse.move(0, 0);
    await shot();
  },
  { scheme: "dark" },
);

await step("chat", async ({ page, shot }) => {
  await home(page);
  await page.getByText("Fix Work").first().click();
  await page.waitForTimeout(1500);
  await openPicker(page, "last");
  await pickAgent(page, /Claude/, /Opus 5\.5/);
  await page.mouse.move(0, 0);
  await shot();
});

writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
await browser.close();
server.close();
