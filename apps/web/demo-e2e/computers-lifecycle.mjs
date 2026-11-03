// Computers lifecycle (Misha 02.11, reports/day_2026-11-02/computers-lifecycle/SPEC.md):
// one "Add computer" window from every entry, "What is it for?", "Bring your
// work?", a full computer's chat waiting for its sleeping MacBook, the one
// computer menu with Remove / Delete, and the three ways (a/b/c) to show the
// secondary path "agents run on the laptop itself". Light theme, 1440 wide, ×2.
//   demo-e2e/build-demo.sh && node demo-e2e/computers-lifecycle.mjs [shots-dir]
import { mkdirSync } from "node:fs";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? null;
if (out) mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
const fails = [];
const pageErrors = [];

async function newPage(world) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 200)));
  await openDemo(page, server.url, world);
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  return page;
}

let page;
const shot = async (name, target = page) => {
  if (out) await target.screenshot({ path: `${out}/${name}.png` });
};
const expect = (what, got, want) => {
  const ok = String(got).includes(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${String(got).replace(/\s+/g, " ").slice(0, 120)}`);
  if (!ok) fails.push(what);
};
const id = (testId) => page.getByTestId(testId).first();
const visible = (testId) =>
  id(testId)
    .isVisible()
    .catch(() => false);
const text = (testId) => id(testId).innerText();
const go = async (hash) => {
  await page.evaluate((target) => {
    location.hash = target;
  }, hash);
  await page.waitForTimeout(1800);
  await dismissBanners(page);
};
async function step(name, body) {
  try {
    await body();
  } catch (error) {
    console.log(`FAIL ${name}: ${String(error).split("\n")[0]}`);
    fails.push(name);
    if (out) {
      const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      await page.screenshot({ path: `${out}/FAIL-${slug}.png` }).catch(() => undefined);
    }
  }
}
const openChip = async () => {
  await page.keyboard.press("Escape");
  await go("#/computer");
  await id("home-computer-pill").click();
  await id("computers-menu").waitFor();
  await page.waitForTimeout(500);
};
const row = (label) =>
  page.getByTestId("computers-menu").locator("li").filter({ hasText: label }).first();

// ── A. Fresh: connect the MacBook as a full computer (variant a) ─────────
page = await newPage({ lc: "fresh", fallback: "a", mac: "online" });

await step("home", async () => {
  await id("home-connect-choice").waitFor({ timeout: 20_000 });
  await shot("a01-home");
});

await step("Home → Connect your AI or other computers → Add computer", async () => {
  await id("home-connect-choice").click();
  await id("connect-choice-computer").waitFor();
  await shot("a02-connect-choice");
  await id("connect-choice-computer").click();
  await id("lc-add-choose").waitFor();
  expect("The window offers the cloud", await text("lc-add-cloud"), "Uno cloud computer");
  expect("…and your own", await text("lc-add-own"), "Your own computer");
  expect("No SSH outside Dev Mode", String(await visible("lc-add-ssh")), "false");
  await shot("a03-add-choose");
});

await step("Your own computer: Mac / Windows / Linux", async () => {
  await id("lc-add-own").click();
  await id("lc-download").waitFor();
  expect("Mac: Download Uno Work first", await text("lc-download"), "Download Uno Work");
  expect("No command until asked", String(await visible("lc-command")), "false");
  await shot("a04-own-mac");
  await id("lc-show-command").click();
  await id("lc-command").waitFor();
  expect("The command", await text("lc-command"), "connect.sh");
  await shot("a05-own-mac-command");
  await id("lc-os-windows").click();
  await page.waitForTimeout(300);
  expect("Windows: Download too", await text("lc-download"), "Download");
  await id("lc-os-linux").click();
  await page.waitForTimeout(300);
  expect("Linux: no Download", String(await visible("lc-download")), "false");
  expect("Linux: the command", await text("lc-command"), "curl");
  await shot("a06-own-linux");
  await id("lc-os-mac").click();
});

await step("MacBook is connected → What is it for?", async () => {
  await id("lc-download").click();
  await id("lc-add-purpose").waitFor({ timeout: 20_000 });
  expect("Connected", await text("lc-add-purpose"), "MacBook is connected");
  expect("Tool for your agents", await text("lc-purpose-tool"), "Agents run commands");
  expect("A full computer", await text("lc-purpose-full"), "Start chats on it");
  await shot("a07-purpose");
});

await step("A full computer → Bring your work?", async () => {
  await id("lc-purpose-full").click();
  await id("lc-add-bring").waitFor({ timeout: 20_000 });
  await id("lc-bring-tool-claude").waitFor({ timeout: 10_000 });
  expect("Claude Code chats", await text("lc-bring-tool-claude"), "4 chats");
  expect("Codex chats", await text("lc-bring-tool-codex"), "2 chats");
  expect("Projects", await text("lc-add-bring"), "landing");
  expect("Key names, no values", await text("lc-add-bring"), "STRIPE_SECRET_KEY");
  expect("The keys note", await text("lc-keys-note"), "never in the project");
  await shot("a08-bring");
  // A key can stay behind.
  await page.getByText("RESEND_API_KEY").click();
  expect("The button counts", await text("lc-bring-start"), "Bring 6 chats, 3 projects");
});

await step("Bring → ready", async () => {
  await id("lc-bring-start").click();
  await id("lc-add-done").waitFor({ timeout: 10_000 });
  expect("Ready", await text("lc-add-done"), "MacBook is ready");
  expect("Projects on all computers", await text("lc-done-projects"), "On all my computers");
  await shot("a09-done");
  await id("lc-done").click();
  await page.waitForTimeout(2500);
});

await step("A new chat on MacBook", async () => {
  await go("#/computer");
  await id("home-computer-chip").click();
  await page.waitForTimeout(500);
  const options = page.getByTestId("new-chat-computer-option");
  expect("The picker lists MacBook", await options.allInnerTexts(), "MacBook");
  await shot("a10-picker");
  await options.filter({ hasText: "MacBook" }).first().click();
  await page.waitForTimeout(500);
  expect("New chat starts on", await text("home-computer-chip"), "MacBook");
  const box = page.getByTestId("home-composer");
  await box.click();
  await box.fill("Run the tests in landing");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  await dismissBanners(page);
  const chip = id("chat-computer-chip");
  expect("The chat says where it runs", await chip.getAttribute("title"), "runs on MacBook");
  await shot("a11-chat-on-macbook");
});

await step("MacBook sleeps → Waiting for MacBook…", async () => {
  await page.evaluate(() => window.__lcDemo.sleep());
  await id("lc-waiting-banner").waitFor({ timeout: 15_000 });
  expect("Waiting", await text("lc-waiting-banner"), "Waiting for MacBook");
  expect("No cloud offer yet", String(await visible("lc-continue-cloud")), "false");
  await shot("a12-waiting");
  await id("lc-continue-cloud").waitFor({ timeout: 25_000 });
  await shot("a13-continue-offer");
});

await step("MacBook wakes → the turn goes on", async () => {
  await page.evaluate(() => window.__lcDemo.wake());
  await page.getByText("MacBook is back").first().waitFor({ timeout: 30_000 });
  expect("No waiting banner", String(await visible("lc-waiting-banner")), "false");
  await shot("a14-resumed");
});

await step("Asleep again → Continue in the cloud", async () => {
  await page.evaluate(() => window.__lcDemo.sleep());
  await id("lc-continue-cloud").waitFor({ timeout: 35_000 });
  await id("lc-continue-cloud").click();
  await page.getByText("Continued from MacBook").first().waitFor({ timeout: 15_000 });
  expect("Now on uno-work", await id("chat-computer-chip").getAttribute("title"), "uno-work");
  await shot("a15-continued-in-cloud");
  await page.evaluate(() => window.__lcDemo.wake());
  await page.waitForTimeout(3000);
});

await step("The computer menu: MacBook (variant a)", async () => {
  await openChip();
  await row("MacBook").locator("button").first().click();
  await page.waitForTimeout(600);
  expect("Used as", await text("lc-purpose-switch"), "Full computer");
  expect("Remove", await text("lc-remove"), "Remove computer");
  await shot("a16-menu-macbook");
  await id("lc-advanced-toggle").click();
  await page.waitForTimeout(300);
  expect("Advanced", await text("lc-advanced"), "Run agents on this computer itself");
  await id("lc-run-here").click();
  await page.waitForTimeout(300);
  expect("Runs here", await text("lc-runs-here-line"), "Agents run on MacBook itself");
  await shot("a17-advanced-run-here");
  await id("lc-run-here").click();
});

await step("Remove MacBook", async () => {
  await id("lc-remove").click();
  await id("lc-remove-dialog").waitFor();
  const body = await text("lc-remove-dialog");
  expect("Access goes", body, "Agents lose access right away");
  expect("Files stay", body, "Your files on MacBook stay");
  expect("Chats stay", body, "read-only until you continue them in the cloud");
  await shot("a18-remove-dialog");
  await id("lc-remove-confirm").click();
  await page.waitForTimeout(2500);
  await openChip();
  expect("MacBook is gone", String(await row("MacBook").count()), "0");
});

await step("Delete free-cloud (type the name)", async () => {
  await row("free-cloud").click();
  await page.waitForTimeout(400);
  await id("lc-delete").click();
  await id("lc-delete-dialog").waitFor();
  const body = await text("lc-delete-dialog");
  expect("Lists what is lost", body, "Files outside synced projects");
  expect("Lists its apps", body, "landing-preview");
  expect("What stays", body, "Synced projects and keys");
  expect("Disabled until the name", String(await id("lc-delete-confirm").isDisabled()), "true");
  await id("lc-delete-name").fill("free-cloud");
  await shot("a19-delete-dialog");
  await id("lc-delete-confirm").click();
  await page.waitForTimeout(2500);
});

await step("The plan's last computer: only Turn off", async () => {
  await openChip();
  expect("free-cloud is gone", String(await row("free-cloud").count()), "0");
  await row("uno-work").locator("button").first().click();
  await page.waitForTimeout(500);
  await id("lc-delete").click();
  await id("lc-delete-last").waitFor();
  expect("Last on the plan", await text("lc-delete-last"), "last computer");
  expect("Turn off", await text("lc-delete-turn-off"), "Turn off");
  await shot("a20-delete-last");
  await page.keyboard.press("Escape");
});
await page.context().close();

// ── B. Fresh: the MacBook as a tool for agents, from the computers menu ──
page = await newPage({ lc: "fresh", fallback: "a", mac: "online" });

await step("Computers menu → Add computer → own (command) → Tool", async () => {
  await openChip();
  await page.getByTestId("computers-menu").getByText("Add computer").click();
  await id("lc-add-choose").waitFor({ timeout: 10_000 });
  await id("lc-add-own").click();
  await id("lc-show-command").click();
  await id("lc-command").locator("button").first().click();
  await id("lc-add-purpose").waitFor({ timeout: 20_000 });
  await id("lc-purpose-tool").click();
  await id("lc-bring-tool-claude").waitFor({ timeout: 10_000 });
  await shot("b01-bring-tool");
  await id("lc-bring-start").click();
  await id("lc-add-done").waitFor();
  expect("Tool: agents can use it", await text("lc-add-done"), "agents can use it");
  await shot("b02-done-tool");
  await id("lc-done").click();
  await page.waitForTimeout(3000);
});

await step("A tool in the computers menu", async () => {
  await openChip();
  const tool = page.getByTestId("lc-tool-row").first();
  expect("Listed as a tool", await tool.innerText(), "Tool for your agents");
  await tool.locator("button").first().click();
  await page.waitForTimeout(400);
  expect("Used as tool", await text("lc-purpose-switch"), "Tool for agents");
  await shot("b03-menu-tool");
  await page.keyboard.press("Escape");
});

await step("An imported chat on a tool computer → Continue in the cloud", async () => {
  await page.waitForTimeout(1500);
  await page.getByText("Fix the landing build").first().click();
  await id("lc-imported-continue-cloud").waitFor({ timeout: 15_000 });
  expect("Imported", await text("imported-chat-note"), "Imported from MacBook");
  await shot("b04-imported-tool-chat");
  await id("lc-imported-continue-cloud").click();
  await page.getByText("Continued from MacBook").first().waitFor({ timeout: 15_000 });
  await shot("b05-imported-continued");
});

await step("Settings → My machines: one Add computer, no trash", async () => {
  await go("#/settings/workspace");
  await id("settings-add-computer").waitFor({ timeout: 10_000 });
  expect("No trash", String(await page.getByRole("button", { name: /^Remove / }).count()), "0");
  await shot("b06-settings-machines");
  await id("settings-add-computer").click();
  await id("lc-add-choose").waitFor();
  await page.keyboard.press("Escape");
});

await step("Settings → Connectors → Connect computer → the same window", async () => {
  await go("#/settings/connectors");
  const connect = page.getByTestId("connector-connect-another");
  await connect.waitFor({ timeout: 10_000 });
  await connect.click();
  await id("lc-add-own-step").waitFor();
  await shot("b07-connectors-own");
  await page.keyboard.press("Escape");
});

await step("My Uno → Add computer → the same window", async () => {
  await go("#/my-uno");
  const add = page.getByRole("button", { name: "Add", exact: true }).first();
  await add.waitFor({ timeout: 10_000 });
  await add.click();
  await id("lc-add-choose").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
});

await step("Dev Mode: SSH, trash and roles come back", async () => {
  await page.evaluate(() => {
    localStorage.setItem("ui_dev_mode", "1");
    window.dispatchEvent(new Event("uno:dev-mode-change"));
  });
  await go("#/settings/workspace");
  await page.waitForTimeout(800);
  await id("settings-add-computer").click();
  await id("lc-add-ssh").waitFor();
  await shot("b08-dev-mode-add");
  await page.keyboard.press("Escape");
});
await page.context().close();

// ── D. The desktop app sets this Mac up itself ───────────────────────────
page = await newPage({ lc: "fresh", fallback: "a", platform: "desktop", mac: "online" });
await step("Desktop app: Make this Mac one of your computers?", async () => {
  await id("lc-this-mac-prompt").waitFor({ timeout: 20_000 });
  expect("The card", await text("lc-this-mac-prompt"), "Make this Mac one of your computers?");
  await shot("d01-this-mac-prompt");
  await id("lc-this-mac-yes").click();
  await page.waitForTimeout(400);
  expect("Installs itself", await text("lc-this-mac-prompt"), "Setting up this Mac");
  await shot("d02-installing");
});
await step("Desktop app: What is it for? with A full computer picked", async () => {
  await id("lc-add-purpose").waitFor({ timeout: 15_000 });
  expect("Full picked", String(await id("lc-purpose-full").getAttribute("data-selected")), "true");
  expect("No terminal command", String(await page.getByTestId("lc-command").count()), "0");
  await shot("d03-purpose-full-picked");
  await id("lc-purpose-continue").click();
  await id("lc-bring-tool-claude").waitFor({ timeout: 15_000 });
  await shot("d04-bring");
  await id("lc-bring-start").click();
  await id("lc-add-done").waitFor();
  expect("Full: start chats", await text("lc-add-done"), "on MacBook");
  await shot("d05-done");
  await id("lc-done").click();
  await page.waitForTimeout(1500);
  expect("The card is gone", String(await visible("lc-this-mac-prompt")), "false");
});
await page.context().close();

// ── Variant b: the desktop app's Settings → This computer ────────────────
page = await newPage({ lc: "connected", fallback: "b", platform: "desktop", mac: "online" });
await step("Variant b: Settings → This computer (desktop app)", async () => {
  await go("#/settings/computer");
  await id("lc-where-agents-run").waitFor({ timeout: 10_000 });
  expect("Where agents run", await text("lc-where-agents-run"), "In your cloud (recommended)");
  expect("No stale owner line", String(await visible("settings-owner-line")), "false");
  expect(
    "Nav says This computer",
    String((await page.getByText("This computer", { exact: true }).count()) > 0),
    "true",
  );
  await shot("v-b1-this-computer");
  await id("lc-where-here").click();
  await page.waitForTimeout(300);
  await shot("v-b2-on-this-mac");
});
await step("Variant b: not in the computer menu, not in the browser", async () => {
  await openChip();
  await row("MacBook").locator("button").first().click();
  await page.waitForTimeout(400);
  expect("No Advanced in b", String(await visible("lc-advanced")), "false");
  await page.keyboard.press("Escape");
});
await page.context().close();

page = await newPage({ lc: "connected", fallback: "b", platform: "cloud", mac: "online" });
await step("Variant b in the browser: no This computer", async () => {
  await go("#/settings/computer");
  await page.waitForTimeout(800);
  expect("Hidden in the web", String(await visible("lc-where-agents-run")), "false");
});
await page.context().close();

// ── Variant c: the same, only in Dev Mode ────────────────────────────────
page = await newPage({ lc: "connected", fallback: "c", platform: "desktop", mac: "online" });
await step("Variant c: hidden without Dev Mode", async () => {
  await go("#/settings/computer");
  await page.waitForTimeout(800);
  expect("Hidden", String(await visible("lc-where-agents-run")), "false");
  await shot("v-c1-no-dev-mode");
  await page.evaluate(() => {
    localStorage.setItem("ui_dev_mode", "1");
    window.dispatchEvent(new Event("uno:dev-mode-change"));
  });
  await go("#/settings/computer");
  await id("lc-where-agents-run").waitFor({ timeout: 10_000 });
  await shot("v-c2-dev-mode");
});
await page.context().close();

// ── Variant a, from the start "already a full computer" ──────────────────
page = await newPage({ lc: "connected", fallback: "a", mac: "online" });
await step("Variant a: the computer menu's Advanced", async () => {
  await openChip();
  await row("MacBook").locator("button").first().click();
  await page.waitForTimeout(400);
  await id("lc-advanced-toggle").click();
  await page.waitForTimeout(300);
  await shot("v-a1-menu-advanced");
});
await step("The demo card", async () => {
  await page.keyboard.press("Escape");
  await id("demo-panel-pill").click();
  await id("demo-panel").waitFor();
  await shot("v-panel");
});
await page.context().close();

await browser.close();
server.close();
const errors = [...new Set(pageErrors)];
if (errors.length > 0) console.log(`page errors (${errors.length}):\n  ${errors.join("\n  ")}`);
console.log(fails.length ? `FAILED (${fails.length}): ${fails.join("; ")}` : "all good");
process.exit(fails.length ? 1 : 0);
