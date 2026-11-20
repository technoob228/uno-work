// T51 mockup (Misha 20.11): team work inside one project — share a chat,
// Andrei's view of it, a session his agent suggests on Misha's computer,
// Project settings → Team with the agents' levels, an agent-to-agent
// exchange in a chat. Demo data only (src/demo/teamCollabDemo.ts).
//
// Usage, on a built demo (demo-e2e/build-demo.sh <dist>):
//   DEMO_DIST=<dist> node demo-e2e/team-collab-shots.mjs <out-dir>
// "before" shots come from the same build with `t51=off` (Work as it is).
import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/team-collab";
const only = process.argv[3] ?? null;
const MAX_BYTES = 400 * 1024;
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();

function say(line) {
  console.log(line);
}

async function newPage(extra = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.clock.setFixedTime(new Date(2026, 10, 20, 14, 20));
  const params = new URLSearchParams({ world: "live", speed: "3", panel: "closed", ...extra });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await hideDemoPanel(page);
  return page;
}

/** JPEG ≤ 400 KB, 1440 wide. */
async function shot(page, name, options = {}) {
  await hideDemoPanel(page);
  const jpg = join(out, `${name}.jpg`);
  for (const quality of [86, 78, 70, 60]) {
    await page.screenshot({ path: jpg, type: "jpeg", quality, ...options });
    if (statSync(jpg).size <= MAX_BYTES) break;
  }
  say(`${jpg} (${Math.round(statSync(jpg).size / 1024)} KB)`);
}

async function hideDemoPanel(page) {
  // The demo's "what to look at" pill on the sidebar's edge: not part of Work.
  await page.addStyleTag({
    content: "[data-testid=demo-panel-pill],[data-testid=demo-panel]{display:none!important}",
  });
}

async function closeToasts(page) {
  // The demo's "Models set for your plans" toast covers the header's right side.
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
  await page.waitForTimeout(700);
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
  if (scrollTo) {
    await page
      .getByTestId(scrollTo)
      .evaluate((el) => {
        el.scrollIntoView({ block: "start" });
        el.closest("[class*=overflow-y-auto]")?.scrollBy(0, -12);
      })
      .catch(() => say(`no ${scrollTo}`));
    await page.waitForTimeout(500);
  }
}

const want = (name) => !only || only.split(",").includes(name);

// ── Before: Work as it is today (same data, T51 off) ─────────────────────
if (want("before")) {
  const page = await newPage({ t51: "off" });
  await openChat(page, "t-stripe");
  await shot(page, "before-chat-header");
  await openNeedsYou(page);
  await shot(page, "before-needs-you");
  await page.keyboard.press("Escape");
  await openProjectSettings(page, "project-team");
  await shot(page, "before-project-team");
  await page.context().close();
}

// ── Misha's Work ─────────────────────────────────────────────────────────
if (want("misha")) {
  const page = await newPage();
  await openChat(page, "t-stripe");
  await shot(page, "walk-1");
  say("walk-1: Misha's chat, Share in the header");

  await page.getByTestId("chat-share-button").click();
  await page.getByTestId("chat-share-popover").waitFor();
  await page.waitForTimeout(400);
  await page
    .getByTestId("chat-share-person-andrei")
    .getByRole("radio", { name: "Can read" })
    .click();
  await page.waitForTimeout(400);
  await shot(page, "after-share-picker");
  await shot(page, "walk-2");
  say("walk-2: the picker: Andrei can read");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await shot(page, "after-chat-header");

  // A request from Andrei's agent: Needs you.
  await openNeedsYou(page);
  await shot(page, "after-needs-you");
  await shot(page, "walk-4");
  say("walk-4: Needs you: Andrei and his agent suggest a session here");
  await page
    .getByTestId("inbox-popover")
    .getByTestId("team-request-tr-session")
    .getByRole("button", { name: "Read the brief" })
    .click();
  await page.getByTestId("team-request-brief").waitFor();
  await page.waitForTimeout(600);
  await shot(page, "after-brief");
  await shot(page, "walk-5");
  say("walk-5: the brief, as Andrei's agent's text, and what the session can't do");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // The agent-to-agent exchange.
  await openChat(page, "t-prices");
  await page
    .getByText(/Agents talked after this/)
    .first()
    .click();
  await page.waitForTimeout(800);
  await shot(page, "after-agent-exchange");
  await shot(page, "walk-6");
  say("walk-6: Andrei's agent asked, Misha's agent answered under Answer questions");

  // Project settings → Team.
  await openProjectSettings(page, "project-team");
  await shot(page, "after-project-team");
  await shot(page, "walk-7");
  say("walk-7: Project settings → Team: people, the agents' levels");
  await page
    .getByTestId("project-team-shared-chats")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(500);
  await shot(page, "after-project-journal");
  await shot(page, "walk-8");
  say("walk-8: the chats you share and what their agents did");
  await page.context().close();
}

// ── Andrei's Work ────────────────────────────────────────────────────────
if (want("andrei")) {
  const page = await newPage({ as: "andrei" });
  await openNeedsYou(page);
  await page.waitForTimeout(400);
  await page
    .getByTestId("inbox-popover")
    .getByTestId("team-request-tr-shared")
    .getByRole("button", { name: "Open" })
    .click();
  await page.waitForTimeout(2200);
  await dismissBanners(page);
  await closeToasts(page);
  await page.mouse.move(900, 500);
  await shot(page, "after-andrei-view");
  await shot(page, "walk-3");
  say("walk-3: Andrei's Work: the shared chat, read-only");
  await page.context().close();
}

await browser.close();
server.close();
