// The fixes after the stage pass of 30.10 in the demo: each step starts on a
// clean browser, checks the behaviour and leaves a screenshot.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/fixes-shots.mjs <out-dir> [prefix]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { composer, dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/fixes";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
const homeBox = (page) => page.getByTestId("home-composer");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function step(name, fn) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  const shot = async (label) => {
    await dismissBanners(page);
    await page.screenshot({ path: join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`) });
  };
  try {
    await openDemo(page, server.url, {});
    const note = await fn({ page, shot });
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("fail").catch(() => {});
  }
  await context.close();
}

async function attachByDrop(page) {
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      document.body.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  });
  await page.getByText("notes.txt").first().waitFor();
}

await step("01-background-with-file", async ({ page, shot }) => {
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.waitForTimeout(500);
  await composer(page).click();
  await composer(page).pressSequentially("Read the notes");
  await attachByDrop(page);
  await shot("attached");
  await page.keyboard.press(`${MOD}+Enter`);
  const toast = page.getByText(/Started in the background|The task didn't start/).first();
  await toast.waitFor();
  await page.waitForTimeout(300);
  await shot();
  const said = await toast.innerText();
  if (said !== "Started in the background") {
    const why = await page
      .evaluate(() => document.querySelector("[data-slot=toast-description]")?.textContent ?? "")
      .catch(() => "");
    throw new Error(`${said}: ${why}`);
  }
  return said;
});

await step("02-home-background", async ({ page, shot }) => {
  await homeBox(page).click();
  await homeBox(page).pressSequentially("Check the backups");
  await page.keyboard.press(`${MOD}+Enter`);
  await page.getByText("Started in the background").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot();
  const hash = await page.evaluate(() => location.hash);
  await homeBox(page).waitFor();
  if ((await homeBox(page).inputValue()) !== "") throw new Error("the box isn't empty");
  return `back on ${hash}`;
});

await step("03-home-set-aside", async ({ page, shot }) => {
  await homeBox(page).click();
  await homeBox(page).pressSequentially("Write the changelog");
  await page.keyboard.press(`${MOD}+s`);
  await page.getByText("Set aside", { exact: true }).first().waitFor();
  await shot("aside");
  if ((await homeBox(page).inputValue()) !== "") throw new Error("the box wasn't cleared");
  await page.getByTestId("composer-stash").waitFor();
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForTimeout(400);
  await shot("back");
  const back = await homeBox(page).inputValue();
  if (back !== "Write the changelog") throw new Error(`not restored: "${back}"`);
});

await step("04-tree-find", async ({ page, shot }) => {
  await page.getByRole("button", { name: "Files", exact: true }).first().click();
  // Tree is the default on a wide window.
  await page.getByTestId("files-tree").waitFor();
  await page.getByTestId("files-tree").getByText("Documents").first().click();
  await page.keyboard.press(`${MOD}+f`);
  await page.waitForTimeout(200);
  await shot();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focused !== "files-search-input") throw new Error(`focus is on ${focused}`);
});

await step("05-prompt-link-asks-first", async ({ page, shot }) => {
  const link = encodeURIComponent("Summarize this repo");
  await page.goto(`${server.url}#/new?prompt=${link}`);
  await page.waitForTimeout(3500);
  await shot();
  const said = await page.locator("[data-chat-composer-form]").first().innerText();
  if (!said.includes("Summarize this repo")) throw new Error(`box: "${said}"`);
  if (said.includes("Full access")) throw new Error("still on Full access");
  return said.split("\n").filter(Boolean).slice(0, 6).join(" · ").slice(0, 160);
});

await step("06-sidebar-view-names", async ({ page, shot }) => {
  await page.goto(`${server.url}#/settings/general`);
  await page.waitForTimeout(2000);
  await page.getByText("Sidebar view", { exact: true }).first().waitFor();
  await page.getByTestId("settings-sidebar-view").click();
  await page.getByRole("option", { name: "By status" }).waitFor();
  await page.getByRole("option", { name: "By project" }).waitFor();
  await shot();
  if ((await page.getByRole("option", { name: "Inbox" }).count()) > 0) {
    throw new Error("Inbox is still an option");
  }
});

writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
await browser.close();
server.close();
process.exit(0);
