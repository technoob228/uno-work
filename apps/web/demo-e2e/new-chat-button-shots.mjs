// T54 (Misha 20.11, demo only): three sizes of New chat on the real sidebar —
// A the small icon (T53), B a full-width button on top, C a split button
// "New chat in <folder>" + ▾ for the picker. `?ncb=a|b|c`.
//
// Usage, on a built demo of demo/new-chat-button-1120 (demo-e2e/build-demo.sh):
//   node demo-e2e/new-chat-button-shots.mjs <out-dir>
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/new-chat-picker";
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

async function open(variant) {
  const params = new URLSearchParams({
    world: "live",
    lc: "off",
    speed: "3",
    panel: "closed",
    ncb: variant,
  });
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

for (const variant of ["a", "b", "c"]) {
  await open(variant);
  await pinAChat();
  await rest();
  await shot(`variant-${variant}`);
  say(`variant-${variant}: the sidebar at rest`);
  const trigger =
    variant === "a"
      ? page.getByTestId("sidebar-d-new-chat")
      : variant === "b"
        ? page.getByTestId("sidebar-top-new-chat")
        : page.getByTestId("sidebar-top-new-chat-picker");
  await trigger.click();
  await page.getByTestId("new-chat-picker").waitFor();
  await page.waitForTimeout(600);
  await shot(`variant-${variant}-picker`);
  say(`variant-${variant}-picker: the picker open`);
  await page.keyboard.press("Escape");
}

await browser.close();
server.close();
writeFileSync(join(out, "variants-log.txt"), `${log.join("\n")}\n`);
