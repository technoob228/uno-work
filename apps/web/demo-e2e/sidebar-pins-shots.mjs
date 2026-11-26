// T65 (Misha 24.11): the sidebar before/after — pinned chats on top of the
// chats, the New chat button, "+ Link" by Pinned, the Inbox always there,
// By status + Only mine by default.
//
// Two sets of the same build:
//   real — like Misha's own sidebar on 0.0.193: his saved view (By status,
//          All chats), three pinned chats and a pinned link, nothing waiting;
//   demo — the rich demo world: things wait, cloud chats ask to start here,
//          and the settings never touched (the defaults apply).
//
// Usage, on a demo build (demo-e2e/build-demo.sh <dir>):
//   DEMO_DIST=<dir> node demo-e2e/sidebar-pins-shots.mjs <out-dir> <before|after>
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/sidebar-pins";
const label = process.argv[3] ?? "after";
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();

/** JPEG ≤ 400 KB (the review's format); `clip` — the sidebar alone. */
async function shot(page, name, clip) {
  for (const quality of [85, 75, 65]) {
    const jpg = join(out, `${label}-${name}.jpg`);
    await page.screenshot({ path: jpg, type: "jpeg", quality, ...(clip ? { clip } : {}) });
    if (statSync(jpg).size <= MAX_BYTES) {
      console.log(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
      return;
    }
    unlinkSync(jpg);
  }
  throw new Error(`${name}: over 400 KB`);
}

async function hideDemoChrome(page) {
  await page.addStyleTag({
    content:
      '[data-testid="demo-panel-pill"], [data-testid="demo-panel"] { display: none !important; }',
  });
  for (const close of await page.locator("[data-slot=toast-close], [aria-label='Close']").all()) {
    await close.click().catch(() => undefined);
  }
}

async function ready(page) {
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  // On a phone the sidebar is a closed sheet: nothing to wait for there.
  await page
    .getByText("Assistants", { exact: true })
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoChrome(page);
}

/**
 * Opens the live world with the sidebar settings given: `levels` — the saved
 * grouping (null: never picked), `onlyMine` — the saved switch (null: never
 * touched).
 */
async function open(page, { levels, onlyMine }) {
  await page.goto(`${server.url}?world=live&lc=off&speed=3&panel=closed`);
  await ready(page);
  await page.evaluate(
    ({ levels, onlyMine }) => {
      const key = "t3code:client-settings:v1";
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...settings, sidebarGroupLevels: levels }));
      if (onlyMine === null) localStorage.removeItem("uno-work:sidebar:only-mine");
      else localStorage.setItem("uno-work:sidebar:only-mine", JSON.stringify(onlyMine));
    },
    { levels, onlyMine },
  );
  await page.reload();
  await ready(page);
}

async function pinChat(page, title) {
  const row = page.locator("[data-testid=sidebar-row-d]", { hasText: title }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: "right" });
  const item = page.getByText("Pin chat", { exact: true }).first();
  if (await item.isVisible().catch(() => false)) await item.click();
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
}

async function pinLink(page, address, name) {
  // Before T65 "+ Link" shows only on hover; force works either way.
  await page.getByTestId("sidebar-pin-link").first().click({ force: true });
  await page.getByLabel("Address").fill(address);
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page.waitForTimeout(600);
}

/** Nothing waiting: the cloud's requests held, the Inbox's questions skipped till tomorrow. */
async function nothingWaits(page) {
  await page.evaluate(() => window.__chatRequestsDemo?.hold?.());
  await page.waitForTimeout(600);
  await page.getByTestId("sidebar-needs-you").first().click();
  await page.waitForTimeout(800);
  const popover = page.getByTestId("inbox-popover");
  for (let i = 0; i < 4; i += 1) {
    const skip = popover.getByText("Skip for now", { exact: true }).first();
    if (!(await skip.isVisible().catch(() => false))) break;
    await skip.click();
    await page.getByText("Tomorrow morning", { exact: false }).first().click();
    await page.waitForTimeout(600);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
}

async function rest(page) {
  await page.mouse.move(900, 880);
  await page.evaluate(() => document.querySelector("[data-sidebar=content]")?.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

/** Collapsed: the rail (⌘B / Ctrl+B). */
async function collapse(page) {
  await page.mouse.click(900, 120);
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(800);
  await rest(page);
}

const SIDEBAR = { x: 0, y: 0, width: 256, height: 900 };

// ── real: like Misha's sidebar ─────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.clock.setFixedTime(new Date(2026, 10, 24, 14, 20));
  await open(page, { levels: ["status"], onlyMine: false });
  await nothingWaits(page);
  await pinChat(page, "A host for the orders bot");
  await pinChat(page, "Nightly backups of the orders DB");
  await pinLink(page, "benches.uno4.me", "benches");
  await rest(page);
  await shot(page, "real-sidebar", SIDEBAR);
  await shot(page, "real-full");
  await collapse(page);
  await shot(page, "real-collapsed", { x: 0, y: 0, width: 420, height: 900 });
  await context.close();
}

// ── demo: rich data, settings never touched ────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.clock.setFixedTime(new Date(2026, 10, 24, 14, 20));
  await open(page, { levels: null, onlyMine: null });
  // The cloud's two requests come in a moment after the start.
  await page
    .getByText("wants to start a chat here")
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  await pinChat(page, "How October went");
  await pinLink(page, "figma.com/file/landing", "Landing in Figma");
  await rest(page);
  await shot(page, "demo-sidebar", SIDEBAR);
  await shot(page, "demo-full");
  // The New chat picker (⌘N opens the same).
  const newChat = page.getByTestId("sidebar-d-new-chat").first();
  await newChat.click();
  await page.getByTestId("new-chat-picker").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot(page, "demo-picker");
  await page.keyboard.press("Escape");
  await collapse(page);
  await shot(page, "demo-collapsed", { x: 0, y: 0, width: 420, height: 900 });
  await context.close();
}

// ── mobile: the sidebar sheet ───────────────────────────────────────────
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(2026, 10, 24, 14, 20));
  await open(page, { levels: null, onlyMine: null });
  const trigger = page.locator("[data-sidebar=trigger]").first();
  if (await trigger.isVisible().catch(() => false)) await trigger.click();
  else await page.keyboard.press("Control+b");
  await page.waitForTimeout(1200);
  await shot(page, "demo-mobile");
  await context.close();
}

await browser.close();
server.close();
