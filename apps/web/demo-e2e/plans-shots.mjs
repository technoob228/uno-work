// AI plans across computers (T3 port 30.10): shots of the demo build in the
// `plans=full` world — Claude at its limit on uno-work, another Claude
// account with room on the MacBook. Tolerant: a step that isn't there (the
// base branch, before the feature) is logged and the walk goes on.
//   DEMO_DIST=<build> node demo-e2e/plans-shots.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/plans";
mkdirSync(out, { recursive: true });
const log = [];
const server = await serve();
const browser = await chromium.launch(process.platform === "darwin" ? { channel: "chrome" } : {});

const CLAUDE = { instanceId: "claudeAgent", model: "claude-sonnet-5" };

async function open(clientSettings) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 860 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((settings) => {
    if (!sessionStorage.getItem("plans-shots")) {
      sessionStorage.setItem("plans-shots", "1");
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    }
  }, clientSettings);
  const page = await context.newPage();
  current = page;
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) =>
    log.push(
      `  pageerror: ${String(error.stack ?? error.message)
        .replace(/\s+/g, " ")
        .slice(0, 400)}`,
    ),
  );
  const params = new URLSearchParams({ world: "live", plans: "full", speed: "3", panel: "closed" });
  await page.goto(`${server.url}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
  await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  return { page, context };
}

const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
let current = null;
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    log.push(`ok   ${name}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    failures += 1;
    await current?.screenshot({ path: join(out, `fail-${failures}.png`) }).catch(() => {});
  }
}
const text = async (page, testId) =>
  (await page.getByTestId(testId).first().innerText()).replace(/\s+/g, " ").slice(0, 220);

async function newChat(page) {
  await page
    .getByTestId("sidebar-new-chat")
    .or(page.getByTestId("sidebar-d-new-chat"))
    .or(page.getByTestId("sidebar-header-new-chat"))
    .first()
    .click();
  await page.getByTestId("draft-hero-heading").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2500);
}

// ── Ask me (default) ──
{
  const { page, context } = await open({ newChatModelSelection: CLAUDE });
  await step("Home: AI plan limits + other computers", async () => {
    const widget = page.getByTestId("home-plan-limits");
    await widget.waitFor({ timeout: 20_000 });
    await widget.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await shot(page, "01-home-plan-limits");
    log.push(`  widget: ${await text(page, "home-plan-limits")}`);
  });
  await step("Home's box: Claude here is at its limit", async () => {
    await page.getByTestId("home-composer").scrollIntoViewIfNeeded();
    await page.getByTestId("home-plan-room").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await shot(page, "01b-home-box-limit");
    log.push(`  home: ${await text(page, "home-plan-room")}`);
    await page.getByTestId("home-plan-room-start-on").click();
    await page.getByTestId("home-computer-chip").getByText("MacBook").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot(page, "01c-home-box-on-macbook");
    await page.getByTestId("home-computer-chip").click();
    await page.getByTestId("new-chat-computer-option").getByText("uno-work").click();
    await page.waitForTimeout(800);
  });
  await step("New chat on uno-work: the plan is at its limit", async () => {
    await newChat(page);
    await shot(page, "02-new-chat");
    log.push(`  hero: ${await text(page, "draft-hero-heading")}`);
    await page.getByTestId("plan-room-notice").waitFor({ timeout: 15_000 });
    log.push(`  notice: ${await text(page, "plan-room-notice")}`);
  });
  await step("Start on MacBook", async () => {
    await page.getByTestId("plan-room-start-on").click();
    await page.getByTestId("draft-hero-heading").getByText("MacBook").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2000);
    await shot(page, "03-started-on-macbook");
    log.push(`  hero: ${await text(page, "draft-hero-heading")}`);
  });
  await step("A chat stopped at the limit", async () => {
    await page.getByText("Fix the signup form on the landing").first().click();
    await page.waitForTimeout(2500);
    await page.getByTestId("chat-plan-limit").waitFor({ timeout: 15_000 });
    await shot(page, "04-chat-stopped-at-limit");
    log.push(`  chat: ${await text(page, "chat-plan-limit")}`);
  });
  await step("New chat on MacBook from the stopped chat", async () => {
    await page.getByTestId("chat-plan-limit-new-chat-there").click();
    await page.getByTestId("draft-hero-heading").getByText("MacBook").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2000);
    await shot(page, "05-new-chat-on-macbook-with-request");
  });
  await step("Settings → AI: Your AI plans", async () => {
    await page.evaluate(() => {
      location.hash = "#/settings/ai";
    });
    await page.waitForTimeout(3000);
    await page.getByText("Your AI plans").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await shot(page, "06-settings-ai-plans");
    log.push(`  claude: ${await text(page, "ai-plans-claude")}`);
  });
  await context.close();
}

// ── Switch by itself ──
{
  const { page, context } = await open({ newChatModelSelection: CLAUDE, planLimitSwitch: "auto" });
  await step("Switch by itself: a new chat starts on the MacBook and says so", async () => {
    await page
      .getByTestId("sidebar-new-chat")
      .or(page.getByTestId("sidebar-d-new-chat"))
      .or(page.getByTestId("sidebar-header-new-chat"))
      .first()
      .click();
    await page.getByTestId("plan-room-started-on").waitFor({ timeout: 25_000 });
    await page.waitForTimeout(1500);
    await shot(page, "07-auto-started-on-macbook");
    log.push(`  note: ${await text(page, "plan-room-started-on")}`);
  });
  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(out, "LOG.txt"), `${log.join("\n")}\n`);
console.log(log.join("\n"));
