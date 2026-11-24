// Cloud agents on the person's Mac (Misha 23.11, 0.0.192): "Don't ask again
// for this chat" on a request and in its brief; Settings → Computer → Cloud
// agents with the switch, Stop cloud agents, every command a cloud agent ran
// there, the trusted chats with Revoke; on the assist demo. Same harness as
// chat-requests-shots.mjs.
// The MacBook is a full computer here (`lc=off`); its Uno Work answers
// `chatRequests.*` (src/demo/chatRequestsDemo.ts). The demo's page is Work on
// uno-work, so Settings → Computer is switched to the MacBook first
// (Settings → My computers → Switch to this machine) — on the Mac itself the
// desktop app opens on it.
//
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   node demo-e2e/mac-remote-shots.mjs <out-dir>
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/mac-remote";
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// System notifications: allowed, and each one written down (a headless
// browser shows none) — the walkthrough logs what would pop up.
await context.grantPermissions(["notifications"], { origin: server.url.replace(/\/$/, "") });
await context.addInitScript(() => {
  window.__notes = [];
  class Recorded extends EventTarget {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) {
      super();
      window.__notes.push({ title, body: options?.body ?? null });
    }
    close() {}
  }
  window.Notification = Recorded;
});
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
// A calm afternoon on the clock (the greeting, "waits until").
await page.clock.setFixedTime(new Date(2026, 10, 23, 14, 20));

const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

/** PNG if it fits in 400 KB, else a JPEG of the same name. */
async function shot(name, options = {}) {
  const png = join(out, `${name}.png`);
  await page.screenshot({ path: png, ...options });
  if (statSync(png).size <= MAX_BYTES) {
    say(`${png} (${Math.round(statSync(png).size / 1024)} KB)`);
    return;
  }
  const jpg = join(out, `${name}.jpg`);
  await page.screenshot({ path: jpg, type: "jpeg", quality: 82, ...options });
  unlinkSync(png);
  say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
}

async function hideDemoPanel() {
  await page.evaluate(() => {
    // The demo's "what to look at" tab on the page's edge: not part of Work.
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

async function open() {
  const params = new URLSearchParams({ world: "live", lc: "off", speed: "3", panel: "closed" });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoPanel();
}

async function go(hash) {
  await page.evaluate((to) => {
    location.hash = to;
  }, hash);
  await page.waitForTimeout(1800);
  await dismissBanners(page);
}

async function openNeedsYou() {
  if (
    !(await page
      .getByTestId("inbox-popover")
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByTestId("sidebar-needs-you").first().click();
  }
  await page.getByTestId("inbox-popover").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
}

async function closePopover() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

/** Settings → Computer for the MacBook (the demo's page belongs to uno-work). */
async function settingsForMac() {
  await go("#/settings/workspace");
  const row = page.getByRole("button", { name: "Switch to this machine" });
  const count = await row.count();
  for (let i = 0; i < count; i += 1) {
    const item = row.nth(i);
    const text = await item.evaluate(
      (el) => el.closest("li, [role=listitem], div.border-t, section")?.textContent ?? "",
    );
    if (text.includes("MacBook")) {
      await item.click();
      break;
    }
  }
  await page.waitForTimeout(1500);
  await go("#/settings/computer");
}

async function waitForPoll() {
  // The listener asks every 5 s.
  await page.waitForTimeout(6000);
}

async function closeToasts() {
  for (const close of await page.locator("[data-slot=toast-close]").all()) {
    await close.click().catch(() => undefined);
  }
  await page.waitForTimeout(500);
}

async function scrollToSection() {
  await page
    .locator("h2", { hasText: /^Cloud agents$/ })
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.move(1300, 120);
  await page.waitForTimeout(500);
}

async function scrollTo(testId) {
  await page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.move(1300, 120);
  await page.waitForTimeout(500);
}

await open();

// 1. A request on the card: the new toggle under Start / Decline.
await waitForPoll();
await openNeedsYou();
const card = page.getByTestId("inbox-popover").getByTestId("chat-request-card-cr-bakery");
await shot("walk-1");
say("walk-1: Needs you: the request with “Don't ask again for this chat”");
await card.getByTestId("chat-request-trust-cr-bakery").click();
await page.waitForTimeout(400);
await shot("after-card");
await shot("walk-2");
say("walk-2: ticked: the line says what it means and where to revoke it");

// 2. The brief: the toggle next to Start; the new line about push and installs.
await card.getByRole("button", { name: "Read the brief" }).click();
await page.getByTestId("chat-request-brief").waitFor();
await page.waitForTimeout(500);
await page.getByTestId("chat-request-brief-trust").click();
await page.waitForTimeout(300);
await shot("after-brief");
await shot("walk-3");
say("walk-3: the brief: push and installs ask each time; the toggle next to Start");

await page.getByTestId("chat-request-brief").getByRole("button", { name: "Start" }).click();
await page.waitForURL(/m-requested-/, { timeout: 10_000 });
await page.waitForTimeout(2000);
await dismissBanners(page);
say(`Start with the toggle opened: ${page.url().split("#")[1]}`);

// 3. Settings → Computer → Cloud agents.
await settingsForMac();
await closeToasts();
await scrollToSection();
await shot("after-settings");
await shot("walk-4");
say("walk-4: Settings → Computer → Cloud agents: the switch, Stop, the command log");

await scrollTo("chat-requests-commands");
await shot("after-commands");
await shot("walk-5");
say("walk-5: every command of a cloud agent here: ran, allowed after a click, refused");

await scrollTo("chat-requests-trusted");
await shot("after-trusted");
await shot("walk-6");
say("walk-6: the chats trusted to start without asking, with Revoke; the journal");

const trustedBefore = await page.getByTestId("chat-requests-trusted").locator("li").count();
await page
  .getByTestId("chat-requests-trusted")
  .getByRole("button", { name: "Revoke" })
  .first()
  .click();
await waitForPoll();
const trustedAfter = await page
  .getByTestId("chat-requests-trusted")
  .locator("li")
  .count()
  .catch(() => 0);
say(`trusted chats: ${trustedBefore} → ${trustedAfter} after Revoke`);

// 4. The kill switch.
await closeToasts();
await scrollToSection();
await page.getByTestId("chat-requests-stop").click();
await page.waitForTimeout(1200);
const checked = await page.getByTestId("chat-requests-allow").getAttribute("aria-checked");
say(`switch after Stop cloud agents: aria-checked=${checked}`);
await shot("after-stopped");
await shot("walk-7");
say("walk-7: Stop cloud agents: off, what ran is stopped, the time is noted");

await browser.close();
server.close();
writeFileSync(join(out, "after-log.txt"), `${log.join("\n")}\n`);
