// A chat on a cloud computer asks to start a chat on the person's Mac
// (Misha 20.11, chatRequests/): Needs you, the sidebar row, the brief, Start,
// the journal and the switch in Settings → Computer, on the assist demo.
// The MacBook is a full computer here (`lc=off`); its Uno Work answers
// `chatRequests.*` (src/demo/chatRequestsDemo.ts). The demo's page is Work on
// uno-work, so Settings → Computer is switched to the MacBook first
// (Settings → My computers → Switch to this machine) — on the Mac itself the
// desktop app opens on it.
//
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   node demo-e2e/chat-requests-shots.mjs <out-dir>            # after-*, walk-*
//   node demo-e2e/chat-requests-shots.mjs <out-dir> --before   # before-* (a base build:
//                                                              # DEMO_DIST=<its dist-demo>)
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/chat-requests";
const before = process.argv.includes("--before");
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
await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));

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

await open();

if (before) {
  // The base version: Needs you and Settings → Computer, no chat requests.
  await page.getByTestId("sidebar-needs-you").first().waitFor({ timeout: 15_000 });
  await openNeedsYou();
  await shot("before-needs-you");
  await closePopover();
  await settingsForMac();
  // Where the new section goes: just above "Safety and more".
  await page
    .getByText("Safety and more", { exact: true })
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "center" }))
    .catch(() => undefined);
  await page.waitForTimeout(400);
  await shot("before-settings");
  say(
    `settings owner line: ${await page
      .getByTestId("settings-owner-line")
      .textContent()
      .catch(() => "—")}`,
  );
} else {
  // Walkthrough: nothing waits; then a request comes in.
  await page.evaluate(() => window.__chatRequestsDemo.hold());
  await waitForPoll();
  await shot("walk-1");
  say("walk-1: Work on the Mac, nothing from the cloud yet");

  await page.evaluate(() => window.__chatRequestsDemo.arrive());
  await waitForPoll();
  const notes = await page.evaluate(() => window.__notes);
  say(`system notifications: ${JSON.stringify(notes)}`);
  await shot("walk-2");
  say("walk-2: the request arrived — the sidebar row, Needs you on Home, the badge");

  await openNeedsYou();
  await shot("walk-3");
  say("walk-3: Needs you: the card with Start / Decline / Read the brief");

  await page
    .getByTestId("inbox-popover")
    .getByTestId("chat-request-card-cr-bakery")
    .getByRole("button", { name: "Read the brief" })
    .click();
  await page.getByTestId("chat-request-brief").waitFor();
  await page.waitForTimeout(500);
  await shot("walk-4");
  say("walk-4: the brief, quoted as the agent's text, and what the chat is held to");

  // The second request arrives too, for the stills of Needs you and the sidebar.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__chatRequestsDemo.arrive());
  await waitForPoll();
  await openNeedsYou();
  await shot("after-needs-you");
  await closePopover();

  // The sidebar while a chat is on screen.
  await page.locator("[data-testid=sidebar-row-d]", { hasText: "Slide 7" }).first().click();
  await page.waitForTimeout(1800);
  await dismissBanners(page);
  await page.mouse.move(900, 600);
  await shot("after-sidebar");

  await page
    .getByTestId("sidebar-chat-request-cr-bakery")
    .getByRole("button", { name: "Brief" })
    .click();
  await page.getByTestId("chat-request-brief").waitFor();
  await page.waitForTimeout(500);
  await shot("after-brief");

  await page.getByTestId("chat-request-brief").getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/m-requested-/, { timeout: 10_000 });
  await page.waitForTimeout(2000);
  await dismissBanners(page);
  await shot("after-started");
  await shot("walk-5");
  say(`walk-5: Start opened the new chat on the MacBook: ${page.url().split("#")[1]}`);

  await settingsForMac();
  await page
    .getByTestId("chat-requests-allow")
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await shot("after-settings");
  await shot("walk-6");
  say("walk-6: Settings → Computer: the switch on, the journal with the started chat");

  await page.getByTestId("chat-requests-allow").click();
  await page.waitForTimeout(800);
  const checked = await page.getByTestId("chat-requests-allow").getAttribute("aria-checked");
  say(`switch after click: aria-checked=${checked}`);
  await shot("after-settings-off");
  await shot("walk-7");
  say("walk-7: the switch off — requests are refused at once");
}

await browser.close();
server.close();
// Keep the log next to the shots.
writeFileSync(join(out, before ? "before-log.txt" : "after-log.txt"), `${log.join("\n")}\n`);
