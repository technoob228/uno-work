// Second account and resume after the limit (T3 port 30.10): shots of the demo
// build. PLANS_WORLD=accounts is the feature; PLANS_WORLD=full on the base
// branch is "before". Tolerant: a step that isn't there is logged, the walk
// goes on.
//   DEMO_DIST=<build> PLANS_WORLD=accounts node demo-e2e/accounts-shots.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/accounts";
const plans = process.env.PLANS_WORLD ?? "accounts";
mkdirSync(out, { recursive: true });
const log = [];
const server = await serve();
const browser = await chromium.launch(process.platform === "darwin" ? { channel: "chrome" } : {});
const context = await browser.newContext({
  viewport: { width: 1360, height: 860 },
  deviceScaleFactor: 2,
});
await context.addInitScript(
  (settings) => {
    if (!sessionStorage.getItem("accounts-shots")) {
      sessionStorage.setItem("accounts-shots", "1");
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    }
  },
  { newChatModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" } },
);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) =>
  log.push(
    `  pageerror: ${String(error.stack ?? error.message)
      .replace(/\s+/g, " ")
      .slice(0, 400)}`,
  ),
);

const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    log.push(`ok   ${name}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    failures += 1;
    await page.screenshot({ path: join(out, `fail-${failures}.png`) }).catch(() => {});
  }
}
const text = async (testId) =>
  (await page.getByTestId(testId).first().innerText()).replace(/\s+/g, " ").slice(0, 240);
const settle = (ms = 1200) => page.waitForTimeout(ms);

const params = new URLSearchParams({ world: "live", plans, speed: "3", panel: "closed" });
await page.goto(`${server.url}?${params}`);
await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 60_000 });
await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 60_000 });
await settle(2500);
await dismissBanners(page);

const openStoppedChat = async () => {
  await page.getByText("Fix the signup form on the landing").first().click();
  await page.getByTestId("chat-plan-limit").waitFor();
  await settle();
};
const openPlans = async () => {
  await page.evaluate(() => {
    location.hash = "#/settings/ai";
  });
  await page.getByText("Your AI plans").first().waitFor();
  await settle(1500);
};
const atPlansEnd = async () => {
  await page
    .getByTestId("settings-plan-limit-switch")
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await settle(600);
};

await step("Chat stopped at the limit", async () => {
  await openStoppedChat();
  await page
    .getByTestId("chat-plan-limit")
    .evaluate((node) => node.scrollIntoView({ block: "center" }));
  await settle(600);
  await shot("01-stopped-chat");
  log.push(`  chat: ${await text("chat-plan-limit")}`);
  log.push(`  resume: ${await text("chat-plan-resume").catch(() => "(none)")}`);
});
await step("Cancel the wait", async () => {
  await page.getByTestId("chat-plan-resume-cancel").click({ timeout: 5000 });
  await page.getByTestId("chat-plan-resume").waitFor({ state: "detached" });
  await settle(600);
  await shot("02-wait-cancelled");
});
await step("Settings: Your AI plans", async () => {
  await openPlans();
  await atPlansEnd();
  await shot("03-settings-plans");
  log.push(`  claude: ${await text("ai-plans-claude")}`);
});
await step("Turn on more than one account: the warning first", async () => {
  await page.getByTestId("settings-multiple-accounts").click({ timeout: 5000 });
  await page.getByTestId("multiple-accounts-warning").waitFor();
  await settle(500);
  await shot("04-warning");
  log.push(`  warning: ${await text("multiple-accounts-warning")}`);
});
await step("Add another Claude account", async () => {
  await page.getByTestId("multiple-accounts-confirm").click();
  await page.getByTestId("add-claude-account").waitFor();
  await settle(600);
  await atPlansEnd();
  await shot("05-add-buttons");
  await page.getByTestId("add-claude-account").click();
  await page.getByTestId("add-provider-account-name").fill("Personal");
  await settle(400);
  await shot("06-add-account-name");
  await page.getByTestId("add-provider-account-continue").click();
  await settle(1500);
  await shot("07-sign-in");
});
await step("Signed in: its own row and its own limit", async () => {
  await page.getByTestId("ai-plans-claude").getByText("personal@getuno.xyz").waitFor({
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  await settle(800);
  await page
    .getByText("Your AI plans")
    .first()
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await settle(600);
  await shot("08-account-in-plans");
  log.push(`  claude: ${await text("ai-plans-claude")}`);
  await atPlansEnd();
  await shot("09-account-in-settings");
  log.push(`  second: ${await text("second-account")}`);
});
await step("Chat at the limit offers the account", async () => {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await settle(1500);
  await openStoppedChat();
  await page
    .getByTestId("chat-plan-limit")
    .evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.getByTestId("chat-plan-limit-continue-with").waitFor({ timeout: 8000 });
  await settle(600);
  await shot("10-continue-with");
  log.push(`  chat: ${await text("chat-plan-limit")}`);
});
await step("Model picker lists the account", async () => {
  await page.locator("[data-chat-provider-model-picker]").first().click({ timeout: 5000 });
  await settle(900);
  await shot("11-model-picker");
  await page.keyboard.press("Escape");
  await settle(400);
});
await step("Continue with the account", async () => {
  await page.getByTestId("chat-plan-limit-continue-with").click({ timeout: 5000 });
  await settle(2500);
  await shot("12-continued");
});

writeFileSync(join(out, "log.txt"), `${log.join("\n")}\n`);
console.log(log.join("\n"));
await browser.close();
server.close?.();
process.exit(0);
