// "Move my projects here" (13.11): the setup's developer way (sign in →
// import → first chat) and the AI path's "Import from my computer", on the
// demo build, 1440 and 390 wide. Each screen is shot whole (the setup page
// scrolls inside the app, so the window grows to fit it).
//   demo-e2e/build-demo.sh && node demo-e2e/onboarding-import-shots.mjs <out-dir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/onboarding-import";
mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
const log = [];
const SIZES = [
  { name: "1440", viewport: { width: 1440, height: 900 } },
  { name: "390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];
// A new account, Claude Code and Codex installed but not signed in, the MacBook
// not connected yet, each project ~5 s to come over.
const DEV_WORLD = { world: "new", plans: "signin", lc: "fresh", bring: "slow", tour: "dev" };

async function open(page, world, { panel = false } = {}) {
  const params = new URLSearchParams({
    world: "live",
    ...world,
    speed: "3",
    ...(panel ? {} : { panel: "closed" }),
  });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await dismissBanners(page);
}

async function go(page, path, search = {}) {
  await page.evaluate(([to, params]) => window.__assistDemo.go(to, params), [path, search]);
  await page.waitForTimeout(800);
}

async function run(name, world, body, { sizes = SIZES, panel = false } = {}) {
  for (const size of sizes) {
    const { name: width, ...device } = size;
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      colorScheme: "light",
      ...device,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message).slice(0, 200)));
    const shot = async (label) => {
      await page.waitForTimeout(500);
      await page.evaluate(async () => {
        await document.fonts.ready;
        // The demo's own "What to look at" tab covers the page.
        for (const el of document.querySelectorAll("div,button")) {
          const text = (el.textContent ?? "").trim();
          if (
            /^(Что смотреть|What to look at)$/.test(text) &&
            String(el.className).includes("shadow")
          )
            el.style.display = "none";
        }
      });
      const tall = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="setup-scroll"]');
        return scroll ? scroll.scrollHeight - scroll.clientHeight : 0;
      });
      const base = device.viewport;
      if (tall > 0) {
        await page.setViewportSize({
          width: base.width,
          height: Math.min(base.height + tall, 2600),
        });
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: join(out, `${name}-${label}-${width}.png`) });
      if (tall > 0) await page.setViewportSize(base);
    };
    try {
      await open(page, world, { panel });
      await body({ page, shot });
      log.push(`ok   ${name} ${width}`);
    } catch (error) {
      log.push(`FAIL ${name} ${width}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
      await page
        .screenshot({ path: join(out, `${name}-failed-${width}.png`) })
        .catch(() => undefined);
    }
    for (const error of errors) log.push(`     pageerror ${name} ${width}: ${error}`);
    await context.close();
  }
}

const id = (page, testId) => page.getByTestId(testId).first();
const primary = (page) => id(page, "setup-primary");
const seeText = (page, text, timeout = 20_000) =>
  page.getByText(text, { exact: false }).first().waitFor({ timeout });
/** An option of Uno's question card: one tap answers. */
async function pick(page, label) {
  const button = page.getByRole("button", { name: label }).last();
  if (await button.isVisible().catch(() => false)) return button.click();
  return page.getByText(label, { exact: true }).last().click();
}

// The way in for a newcomer: Uno's first question → "I build software" → two buttons.
await run("00-uno", DEV_WORLD, async ({ page, shot }) => {
  await seeText(page, "what do you mostly do");
  await shot("1-question");
  await pick(page, "I build software");
  await seeText(page, "Sign in to Claude Code / Codex");
  await shot("2-developer-way");
  await pick(page, "Sign in to Claude Code / Codex");
  await id(page, "setup-dev-agent-claudeAgent").waitFor();
  await shot("3-sign-in");
});

// The same in their own words.
await run(
  "00-uno-own-words",
  DEV_WORLD,
  async ({ page, shot }) => {
    await seeText(page, "what do you mostly do");
    await page.getByPlaceholder("Or in your own words").fill("I'm a developer");
    await page.getByRole("button", { name: "Save" }).last().click();
    await seeText(page, "Import projects from my computer");
    await shot("developer-way");
  },
  { sizes: [SIZES[0]] },
);

// The demo's own card for this path, as a fresh browser opens it.
await run(
  "00-demo-panel",
  DEV_WORLD,
  async ({ page }) => {
    // Open at the start; the shot's own clicks (banners) may have folded it.
    if (
      await id(page, "demo-panel-pill")
        .isVisible()
        .catch(() => false)
    )
      await id(page, "demo-panel-pill").click();
    await id(page, "demo-panel").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, "00-demo-panel-1440.png") });
  },
  { sizes: [SIZES[0]], panel: true },
);

// Home's first screen: the third way is a line under the composer.
await run("01-home", { ...DEV_WORLD }, async ({ page, shot }) => {
  await go(page, "/");
  await id(page, "home-move-projects").waitFor();
  await shot("first-screen");
});

// The chooser: three ways, the developer one picked.
await run("02-choose", { ...DEV_WORLD }, async ({ page, shot }) => {
  await go(page, "/setup", { step: "start" });
  await id(page, "welcome-dev").click();
  await shot("dev-picked");
});

// The whole developer way, one screen after another.
await run("03-dev", { ...DEV_WORLD }, async ({ page, shot }) => {
  await go(page, "/setup", { step: "start" });
  await id(page, "welcome-dev").click();
  await primary(page).click();
  await id(page, "setup-dev-agent-claudeAgent").waitFor();
  await page
    .locator('[data-testid="setup-dev-agent-claudeAgent"][data-status="needsSignIn"]')
    .waitFor();
  await shot("1-sign-in");
  await id(page, "setup-dev-agent-claudeAgent").click();
  await id(page, "harness-sign-in-account").waitFor();
  await shot("1-sign-in-panel");
  await id(page, "harness-sign-in-account").click();
  await page
    .locator('[data-testid="setup-dev-agent-claudeAgent"][data-status="signedIn"]')
    .waitFor({ timeout: 20_000 });
  await shot("1-signed-in");
  await primary(page).click();

  await id(page, "setup-import-connect").waitFor();
  await shot("2-import-connect");
  await id(page, "lc-download").click();
  await id(page, "setup-import-purpose").waitFor({ timeout: 15_000 });
  await shot("2-import-purpose");
  await id(page, "lc-purpose-full").click();
  await id(page, "setup-import-bring").waitFor({ timeout: 15_000 });
  await id(page, "lc-bring-project-ios-app").waitFor();
  // ios-app is too big to come over: pick it too, to show its error later.
  const ios = page.locator('[data-testid="lc-bring-project-ios-app"] [role="checkbox"]').first();
  if ((await ios.getAttribute("aria-checked")) !== "true") await ios.click();
  await shot("2-import-bring");
  await primary(page).click();

  await id(page, "setup-brought").waitFor();
  await page.locator('[data-testid^="setup-brought-"][data-state="copying"]').first().waitFor();
  await shot("3-first-chat-copying");
  await page
    .locator('[data-testid^="setup-brought-"][data-state="copying"]')
    .first()
    .waitFor({ state: "detached", timeout: 30_000 });
  await shot("3-first-chat-ready");
  await primary(page).click();
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  await shot("4-chat-opened");
});

// The AI path's Project step: "Import from my computer" next to "New project".
await run("04-project-step", { ...DEV_WORLD, lc: "connected" }, async ({ page, shot }) => {
  await go(page, "/setup", { step: "project" });
  await id(page, "setup-project-source").waitFor();
  await shot("new-project");
  await id(page, "setup-project-source-import").click();
  await id(page, "setup-import-pick").waitFor();
  await shot("import-pick-computer");
  await page.locator('[data-testid^="setup-import-computer-"]').first().click();
  await id(page, "setup-import-bring").waitFor({ timeout: 15_000 });
  await id(page, "lc-bring-project-landing").waitFor({ timeout: 15_000 });
  await shot("import-bring");
  await primary(page).click();
  await id(page, "setup-project-copying").waitFor();
  await shot("import-copying");
});

console.log(log.join("\n"));
await browser.close();
server.close();
