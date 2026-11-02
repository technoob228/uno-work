// Home, Files and Add computer of 01.11, on two builds to compare.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/home-calm-shots.mjs <out-dir> before|after
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/home-calm";
const prefix = process.argv[3] ?? "after";
const after = prefix === "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
const WORLD = { fleet: "on", pair: "on", plans: "full" };

async function step(name, fn, { width = 1280 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  const shot = (label = "") =>
    page.screenshot({ path: join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`) });
  try {
    await openDemo(page, server.url, WORLD);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div,button")) {
        const text = (el.textContent ?? "").trim();
        if (/^(Что смотреть|What to look at)/.test(text) && String(el.className).includes("shadow"))
          el.style.display = "none";
      }
    });
    log.push(`ok ${name}: ${(await fn({ page, shot })) ?? ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("failed").catch(() => undefined);
  }
  await context.close();
}

async function home(page) {
  await page
    .getByRole("link", { name: "Home" })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.getByTestId("home-composer").waitFor();
  await page.waitForTimeout(1200);
}

await step("home", async ({ page, shot }) => {
  await home(page);
  await shot();
  const row = await page.getByTestId("home-composer-chips").boundingBox();
  const hidden = await page
    .getByTestId("home-composer-chips")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  return `chips ${Math.round(row.width)} px, cut off ${hidden} px`;
});

await step(
  "home-narrow",
  async ({ page, shot }) => {
    await home(page);
    await shot();
    return page
      .getByTestId("home-composer-chips")
      .evaluate((el) => `cut off ${el.scrollWidth - el.clientWidth} px`);
  },
  { width: 900 },
);

await step("home-narrow-summary", async ({ page, shot }) => {
  await home(page);
  const read = () =>
    page.getByTestId("home-composer-chips").evaluate((el) => {
      const summary = el.querySelector("[data-testid=home-composer-settings-summary]");
      return `chips ${el.clientWidth} px, cut off ${el.scrollWidth - el.clientWidth} px, words ${summary?.offsetWidth ? "on" : "off"}`;
    });
  const wide = await read();
  await page.setViewportSize({ width: 640, height: 860 });
  await page.waitForTimeout(400);
  await shot();
  return `${wide}; at 640: ${await read()}`;
});

await step("computers-menu", async ({ page, shot }) => {
  await home(page);
  await page.getByTestId("home-computer-pill").click();
  await page.getByTestId("computers-menu").waitFor();
  await page.waitForTimeout(400);
  await shot();
  return `${await page.getByTestId("computers-chip-mark").count()} marks`;
});

if (after) {
  await step("settings", async ({ page, shot }) => {
    await home(page);
    await page.getByTestId("home-composer-settings").click();
    await page.getByTestId("home-permission-full-access").waitFor();
    await page.waitForTimeout(300);
    await shot();
  });
  await step("connect", async ({ page, shot }) => {
    await home(page);
    await page.getByTestId("home-connect-choice").click();
    await page.getByTestId("connect-choice-ai").waitFor();
    await page.waitForTimeout(300);
    await shot("choice");
    await page.getByTestId("connect-choice-computer").click();
    await page.getByTestId("add-env-pair").waitFor();
    await page.waitForTimeout(300);
    await shot("add");
    await page.getByTestId("add-env-pair").click();
    await page.getByTestId("connect-warning").waitFor();
    await page.waitForTimeout(300);
    await shot("warning");
  });
  await step("connect-ai", async ({ page, shot }) => {
    await home(page);
    await page.getByTestId("home-connect-choice").click();
    await page.getByTestId("connect-choice-ai").click();
    await page.getByRole("tab", { name: "My AI agent" }).waitFor();
    await page.waitForTimeout(400);
    await shot();
  });
} else {
  await step("add", async ({ page, shot }) => {
    await home(page);
    await page.getByTestId("home-computer-pill").click();
    await page.getByText("Add computer", { exact: true }).click();
    await page.getByText("Add a machine").waitFor();
    await page.waitForTimeout(300);
    await shot();
  });
}

await step("files", async ({ page, shot }) => {
  await page.getByTestId("sidebar-nav-files").click();
  await page.getByRole("tablist", { name: "Location" }).waitFor();
  await page.waitForTimeout(800);
  await shot();
  const menu = page.getByTestId("files-computer-menu");
  if (await menu.count()) {
    await menu.click();
    await page.getByTestId("files-computer-option").first().waitFor();
    await page.waitForTimeout(300);
    await shot("menu");
    const options = await page.getByTestId("files-computer-option").allInnerTexts();
    await page.getByTestId("files-computer-option").last().click();
    await page.waitForTimeout(1000);
    await shot("picked");
    return `computers: ${options.join(", ")}; url ${page.url().split("?")[1] ?? ""}`;
  }
  return "no menu";
});

await step("sidebar", async ({ page, shot }) => {
  await home(page);
  await page.getByTestId("sidebar-d-view-trigger").click();
  await page.getByTestId("sidebar-d-view-menu").waitFor();
  await page.getByTestId("sidebar-d-preset-computer").click();
  await page.waitForTimeout(300);
  await shot("menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await shot();
});

await step("funnel", async ({ page, shot }) => {
  await home(page);
  await page.getByTestId("sidebar-d-project-filter").click();
  await page.getByTestId("sidebar-d-computer-filter").waitFor();
  await page.waitForTimeout(300);
  await shot();
  return `${await page.getByTestId("sidebar-d-computer-filter").getByRole("button").count()} rows`;
});

await step("assistant", async ({ page, shot }) => {
  await page.evaluate(() => {
    location.hash = "#/assistants?view=profile&env=env-demo-uno-work&project=assistant-mia";
  });
  await page.getByTestId("assistant-profile-tabs").waitFor();
  await page.waitForTimeout(800);
  await shot();
  const tabs = await page.getByRole("tab").allInnerTexts();
  for (const id of ["where", "apps"]) {
    await page.getByTestId(`assistant-profile-tab-${id}`).click();
    await page.waitForTimeout(600);
    await shot(id);
  }
  return `tabs: ${tabs.join(" | ")}`;
});

writeFileSync(join(out, `${prefix}-log.txt`), log.join("\n") + "\n");
console.log(log.join("\n"));
await browser.close();
server.close();
process.exit(0);
