// New chat → the picker of computer and folder on the button (Misha 20.11,
// T53), and Pinned's "+" that read as "new chat", on the assist demo.
//
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   node demo-e2e/new-chat-picker-shots.mjs <out-dir>            # after-*, walk-*
//   node demo-e2e/new-chat-picker-shots.mjs <out-dir> --before   # before-* (a base build:
//                                                                # DEMO_DIST=<its dist-demo>)
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/new-chat-picker";
const before = process.argv.includes("--before");
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));

const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

/** JPEG ≤ 400 KB, 1440 wide (the review's format). */
async function shot(name) {
  for (const quality of [80, 70, 60]) {
    const jpg = join(out, `${name}.jpg`);
    await page.screenshot({ path: jpg, type: "jpeg", quality });
    if (statSync(jpg).size <= MAX_BYTES) {
      say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
      return;
    }
    unlinkSync(jpg);
  }
  throw new Error(`${name}: over 400 KB`);
}

async function hideDemoChrome() {
  // The demo's "what to look at" tab on the page's edge: not part of Work.
  await page.addStyleTag({
    content:
      '[data-testid="demo-panel-pill"], [data-testid="demo-panel"] { display: none !important; }',
  });
  // "Models set for your plans" — a one-time toast.
  const close = page.getByRole("button", { name: /close|dismiss/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => undefined);
  for (const toast of await page.locator("[data-slot=toast-close], [aria-label='Close']").all()) {
    await toast.click().catch(() => undefined);
  }
}

async function open() {
  const params = new URLSearchParams({ world: "live", lc: "off", speed: "3", panel: "closed" });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoChrome();
}

/** A pinned chat, so Pinned shows over the chats (as in Misha's sidebar). */
async function pinAChat() {
  const row = page.locator("[data-testid=sidebar-row-d]", { hasText: "How October went" }).first();
  await row.click({ button: "right" });
  await page.getByText("Pin chat", { exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape").catch(() => undefined);
}

async function rest() {
  await page.mouse.move(900, 860);
  await page.waitForTimeout(400);
}

await open();
await pinAChat();
await rest();

if (before) {
  await shot("before-sidebar");
  say("before-sidebar: Pinned with its +, right over My chats with New chat");
  await page.getByTestId("sidebar-d-new-chat").click();
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  await hideDemoChrome();
  await rest();
  await shot("before-new-chat");
  say(`before-new-chat: New chat opened the start screen: ${page.url().split("#")[1]}`);
} else {
  await shot("walk-1");
  await shot("after-sidebar");
  say("walk-1: the sidebar at rest — Pinned has no +");

  await page.getByText("Pinned", { exact: true }).first().hover();
  await page.waitForTimeout(400);
  await shot("after-pinned-hover");
  say("after-pinned-hover: pointer on Pinned — '+ Link' shows");

  await page.getByTestId("sidebar-d-new-chat").click();
  await page.getByTestId("new-chat-picker").waitFor();
  await page.waitForTimeout(600);
  await shot("walk-2");
  await shot("after-picker");
  say(
    `walk-2: the picker — highlighted: ${await page
      .locator("[data-testid=new-chat-picker] [aria-selected=true]")
      .textContent()}`,
  );

  await page.keyboard.type("ord");
  await page.waitForTimeout(400);
  await shot("walk-3");
  say("walk-3: typed 'ord' — the folders filter");

  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);
  await shot("walk-4");
  await shot("after-picker-computer");
  say(
    `walk-4: Tab — the next computer: ${await page
      .locator("[data-testid=new-chat-picker-computer][aria-pressed=true]")
      .textContent()}`,
  );
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(600);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const picked = await page
    .locator("[data-testid=new-chat-picker] [aria-selected=true]")
    .textContent();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  await hideDemoChrome();
  await rest();
  await shot("walk-5");
  await shot("after-started");
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("contenteditable") === "true",
  );
  say(
    `walk-5: ↓ Enter — the chat opened in ${picked}: ${page.url().split("#")[1]}; composer focused: ${focused}`,
  );

  await page.getByTestId("sidebar-d-new-chat").click();
  await page.getByTestId("new-chat-picker").waitFor();
  await page.waitForTimeout(600);
  await shot("walk-6");
  say(
    `walk-6: New chat again — remembers: ${await page
      .locator("[data-testid=new-chat-picker] [aria-selected=true]")
      .textContent()}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(600);
  say(
    `⌃N/⌘N opens the picker: ${await page
      .getByTestId("new-chat-picker")
      .isVisible()
      .catch(() => false)}`,
  );
}

await browser.close();
server.close();
writeFileSync(join(out, before ? "before-log.txt" : "after-log.txt"), `${log.join("\n")}\n`);
