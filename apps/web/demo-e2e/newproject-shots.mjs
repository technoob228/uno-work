// New chat without a project, and a new project with its computer and where it
// syncs (Misha 30.10). Each step starts on a clean browser.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/newproject-shots.mjs <out-dir> [before|after]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/newproject";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];

async function step(name, world, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) return;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  if (process.env.DEMO_DEBUG) {
    page.on("console", (message) => {
      if (message.text().includes("[np-debug]"))
        log.push(`${name}: ${message.text().slice(0, 400)}`);
    });
  }
  const shot = async (label) => {
    await page.screenshot({ path: join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`) });
  };
  try {
    await openDemo(page, server.url, world);
    const note = await fn({ page, shot });
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("fail").catch(() => {});
  }
  await context.close();
}

const openPicker = async (page) => {
  const chip = page.getByTestId("home-folder-chip");
  await chip.waitFor();
  await chip.click();
  await page.getByPlaceholder(/^Search/).waitFor();
};
const openNewProject = async (page) => {
  await openPicker(page);
  await page.getByRole("option", { name: "New project…" }).click();
  await page.getByTestId("new-project-dialog").waitFor();
};

await step("picker", {}, async ({ page, shot }) => {
  await openPicker(page);
  await page.waitForTimeout(300);
  await shot();
  const options = await page.getByRole("option").allInnerTexts();
  return options.join(" | ");
});

if (prefix === "before") {
  await step("dialog", {}, async ({ page, shot }) => {
    await openPicker(page);
    await page.getByRole("option", { name: "New folder…" }).click();
    await page.getByTestId("new-project-dialog").waitFor();
    await page.waitForTimeout(300);
    await shot();
  });
} else {
  await step("no-project-home", {}, async ({ page, shot }) => {
    await openPicker(page);
    await page.getByRole("option", { name: "No project" }).click();
    const chip = await page.getByTestId("home-folder-chip").innerText();
    if (!chip.includes("No project")) throw new Error(`chip says ${chip}`);
    await page.waitForTimeout(300);
    await shot();
  });

  await step("no-project-draft", {}, async ({ page, shot }) => {
    await page
      .getByTestId("sidebar-new-chat")
      .or(page.getByTestId("sidebar-d-new-chat"))
      .or(page.getByTestId("sidebar-header-new-chat"))
      .first()
      .click();
    const picker = page.getByTestId("new-chat-folder-picker").first();
    await picker.waitFor();
    await picker.click();
    await page.getByRole("option", { name: "No project" }).click();
    await page.getByTestId("draft-hero-heading").getByText("New chat").first().waitFor();
    await page.waitForTimeout(400);
    await shot();
    return (await page.getByTestId("draft-hero-heading").innerText()).replace(/\s+/g, " ");
  });

  await step("dialog-nothing-connected", {}, async ({ page, shot }) => {
    await openNewProject(page);
    await page.locator("#new-project-name").fill("Pinball stats");
    await page.waitForTimeout(300);
    await shot();
    const rows = await page
      .getByTestId("new-project-destinations")
      .locator("label")
      .allInnerTexts();
    if (rows.some((row) => /GitHub|GitLab/.test(row))) throw new Error("an empty host is shown");
    return `${rows.length} choices, the first: ${rows[0]?.split("\n")[0]}`;
  });

  await step("dialog-hosts", { hosts: "github,gitlab" }, async ({ page, shot }) => {
    await openNewProject(page);
    await page.locator("#new-project-name").fill("pinball-stats");
    await page.getByTestId("new-project-destination-github").click();
    await page.waitForTimeout(300);
    await shot();
    const text = await page.getByTestId("new-project-destinations").innerText();
    const banned = /\b(git|commit|branch|repository|push|pull)\b/i.exec(text);
    if (banned) throw new Error(`"${banned[0]}" shows outside Dev Mode`);
  });

  await step("dialog-dev-mode", { hosts: "github,gitlab" }, async ({ page, shot }) => {
    await page.evaluate(() => {
      localStorage.setItem("ui_dev_mode", "1");
      window.dispatchEvent(new Event("uno:dev-mode-change"));
    });
    await page.reload();
    await page.getByText("Assistants", { exact: true }).first().waitFor({ timeout: 30_000 });
    await dismissBanners(page);
    await openNewProject(page);
    await page.locator("#new-project-name").fill("pinball-stats");
    await page.getByTestId("new-project-destination-github").click();
    await page.waitForTimeout(300);
    await shot();
    return page.getByTestId("new-project-destination-detail-github").innerText();
  });

  await step("create-on-github", { hosts: "github" }, async ({ page, shot }) => {
    await openNewProject(page);
    await page.locator("#new-project-name").fill("pinball-stats");
    await page.getByTestId("new-project-destination-github").click();
    await page.getByTestId("new-project-submit").click();
    await page.getByTestId("new-project-dialog").waitFor({ state: "hidden" });
    await page.getByText("pinball-stats is on GitHub").first().waitFor();
    await page.waitForTimeout(300);
    await shot();
  });

  await step("computer-choice", { hosts: "github", mac: "online" }, async ({ page, shot }) => {
    await openNewProject(page);
    await page.locator("#new-project-name").fill("pinball-stats");
    await page.getByTestId("new-project-computer-picker").click();
    await page.getByTestId("new-chat-computer-option").getByText("MacBook").click();
    await page.locator("#new-project-name").waitFor();
    await page.waitForTimeout(600);
    await shot();
    const name = await page.locator("#new-project-name").inputValue();
    if (name !== "pinball-stats") throw new Error(`the name was lost: "${name}"`);
    return page.getByTestId("new-project-computer-picker").innerText();
  });

  await step("title-on-hover", {}, async ({ page }) => {
    const title = page.locator('[data-testid^="thread-title-"]').first();
    await title.waitFor();
    const full = await title.getAttribute("title");
    if (!full) throw new Error("no title on hover");
    return full;
  });
}

await browser.close();
server.close();
console.log(log.join("\n"));
process.exit(log.some((line) => line.startsWith("FAIL")) ? 1 : 0);
