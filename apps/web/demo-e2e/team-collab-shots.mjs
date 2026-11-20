// T51 "Team in a project" (20.11), the real Work interface on the demo:
// share a chat, Andrei's view of it (read, then write), From your team in
// Needs you, the brief, Project settings → Team (owner and editor), shared
// chats and the journal, the label on a message from Andrei's agent.
// Demo data: src/demo/teamCollabDemo.ts (?t51=on|off, ?as=andrei, ?share=write).
//
// Usage, on a built demo (demo-e2e/build-demo.sh <dist>):
//   DEMO_DIST=<dist> node demo-e2e/team-collab-shots.mjs <out-dir> [before,misha,andrei,write]
// Browser: harness.mjs (DEMO_CHROME=<chromium> on a Linux box).
// "before" shots come from the same build with `t51=off` (Work as it is).
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/team-collab";
const only = process.argv[3] ?? null;
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const walk = [];

const say = (line) => console.log(line);

async function newPage(extra = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => say(`pageerror: ${error.message}`));
  const params = new URLSearchParams({
    world: "live",
    speed: "3",
    panel: "closed",
    t51: "on",
    ...extra,
  });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoPanel(page);
  return page;
}

/** JPEG ≤ 400 KB, 1440 wide. */
async function shot(page, name) {
  await hideDemoPanel(page);
  const jpg = join(out, `${name}.jpg`);
  for (const quality of [86, 78, 70, 60]) {
    await page.screenshot({ path: jpg, type: "jpeg", quality });
    if (statSync(jpg).size <= MAX_BYTES) break;
  }
  say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
}

/** A walk step: its own file, numbered in order. */
async function step(page, line) {
  walk.push(line);
  await shot(page, `walk-${walk.length}`);
  say(`  walk-${walk.length}: ${line}`);
}

async function hideDemoPanel(page) {
  // The demo's "what to look at" pill on the sidebar's edge: not part of Work.
  await page.addStyleTag({
    content: "[data-testid=demo-panel-pill],[data-testid=demo-panel]{display:none!important}",
  });
}

async function closeToasts(page) {
  for (const button of await page.getByRole("button", { name: /close|dismiss/i }).all()) {
    if (await button.isVisible().catch(() => false)) {
      const box = await button.boundingBox();
      if (box && box.y < 200 && box.x > 1000) await button.click().catch(() => undefined);
    }
  }
  await page.waitForTimeout(300);
}

async function go(page, hash) {
  await page.evaluate((to) => {
    location.hash = to;
  }, hash);
  await page.waitForTimeout(1800);
  await dismissBanners(page);
  await hideDemoPanel(page);
  await closeToasts(page);
}

async function openChat(page, threadId) {
  await go(page, `#/env-demo-uno-work/${threadId}`);
  await page.mouse.move(900, 500);
}

async function openNeedsYou(page) {
  await page.getByTestId("sidebar-needs-you").first().click();
  await page.getByTestId("inbox-popover").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(900);
}

async function openProjectSettings(page, scrollTo) {
  await go(page, "#/settings/projects");
  const row = page.locator("div", { hasText: "/home/uno/projects/landing" }).last();
  await row
    .getByRole("button", { name: "Settings" })
    .first()
    .click()
    .catch(async () => {
      await page.getByRole("button", { name: "Settings" }).first().click();
    });
  await page.getByTestId("project-settings-dialog").waitFor();
  await page.waitForTimeout(1500);
  if (scrollTo) await scrollInDialog(page, scrollTo);
}

async function scrollInDialog(page, testId) {
  await page
    .getByTestId(testId)
    .evaluate((el) => {
      el.scrollIntoView({ block: "start" });
      el.closest("[class*=overflow-y-auto]")?.scrollBy(0, -12);
    })
    .catch(() => say(`no ${testId}`));
  await page.waitForTimeout(500);
}

const want = (name) => !only || only.split(",").includes(name);

// ── Before: Work as it is today (same data and team, T51 off) ────────────
if (want("before")) {
  // `lc=off`: the MacBook is paired, so its chat requests (T50) show.
  const page = await newPage({ t51: "off", lc: "off" });
  await openChat(page, "t-stripe");
  await shot(page, "before-chat-header");
  await openNeedsYou(page);
  await shot(page, "before-needs-you");
  await page.context().close();
  const settings = await newPage({ t51: "off" });
  await openProjectSettings(settings, "project-team");
  await shot(settings, "before-project-team");
  await settings.context().close();
}

// ── Misha's Work (the owner) ─────────────────────────────────────────────
if (want("misha")) {
  const page = await newPage({ lc: "off" });
  await openChat(page, "t-stripe");
  await page.getByTestId("chat-share-button").waitFor({ timeout: 15_000 });
  await shot(page, "after-chat-header");
  await step(page, "Misha's chat: Shared with Andrei, in the header");

  await page.getByTestId("chat-share-button").click();
  await page.getByTestId("chat-share-popover").waitFor();
  await page.waitForTimeout(600);
  await shot(page, "after-share-picker");
  await step(page, "The picker: people of landing, No access / Can read / Can write");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await openNeedsYou(page);
  await page.getByTestId("inbox-popover").getByTestId("team-requests").waitFor();
  await shot(page, "after-needs-you");
  await step(page, "Needs you: From your team, above the chats from the cloud");
  await page
    .getByTestId("inbox-popover")
    .getByTestId("team-session-cr-team-andrei")
    .getByRole("button", { name: "Read the brief" })
    .click();
  await page.getByTestId("chat-request-brief").waitFor();
  await page.waitForTimeout(600);
  await shot(page, "after-brief");
  await step(page, "The brief: Andrei's agent's text, what the session can't do, the level");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await openChat(page, "t-prices");
  await page.getByTestId("team-agent-message").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot(page, "after-agent-exchange");
  await step(page, "A message from Andrei's agent: his face, his chat, the level");

  await page.context().close();

  const settings = await newPage();
  await openProjectSettings(settings, "project-team");
  await shot(settings, "after-project-team-owner");
  await step(settings, "Project settings: People is Team");
  await scrollInDialog(settings, "project-team-agents");
  await shot(settings, "after-project-levels-owner");
  await step(settings, "Their agents and yours: the owner sets the levels");
  await scrollInDialog(settings, "project-team-shared-chats");
  await shot(settings, "after-project-journal");
  await step(settings, "Chats you share, with Stop; what their agents did");
  await settings.context().close();
}

// ── Andrei's Work (an editor): the chat to read ──────────────────────────
if (want("andrei")) {
  const page = await newPage({ as: "andrei" });
  await page.getByTestId("sidebar-shared-with-me").waitFor({ timeout: 20_000 });
  await page.getByTestId("sidebar-shared-chat-9001").click();
  await page.getByTestId("shared-chat-readonly").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1200);
  await dismissBanners(page);
  await closeToasts(page);
  await shot(page, "after-andrei-view");
  await step(page, "Andrei's Work: Shared with you, Misha's chat to read");
  await page.getByTestId("shared-chat-ask-to-write").click();
  await page.waitForTimeout(800);
  await shot(page, "after-andrei-asked");
  await step(page, "Ask to write: the request goes to Misha");

  await openProjectSettings(page, "project-team-agents");
  await shot(page, "after-project-levels-editor");
  await step(page, "Andrei's Team: what Misha set, and Lower for my computers");
  await page.context().close();
}

// ── Andrei can write ─────────────────────────────────────────────────────
if (want("write")) {
  const page = await newPage({ as: "andrei", share: "write" });
  await go(page, "#/shared/9001");
  await page.getByTestId("shared-chat-composer").waitFor({ timeout: 15_000 });
  await page
    .getByTestId("shared-chat-composer")
    .locator("textarea")
    .fill("Can you check that a cancelled Checkout leaves nothing in the orders table?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4500);
  await shot(page, "after-andrei-write");
  await step(page, "With Can write: Andrei's message goes to Misha's agent, signed");
  await page.context().close();
}

await browser.close();
server.close();
