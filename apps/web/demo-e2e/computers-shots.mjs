// The computers stream of 30.10 in the demo: pins, the Bring your own card, Fix
// Work, Update everything, moving a project. Run it on two builds to compare.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/computers-shots.mjs <out-dir> before|after
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/computers";
const prefix = process.argv[3] ?? "after";
const after = prefix === "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];

async function step(name, fn, { only = false, world = {} } = {}) {
  if (only && !after) return;
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
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div,button")) {
        const text = (el.textContent ?? "").trim();
        if (/^(Что смотреть|What to look at|Ассистенты · D)/.test(text)) {
          if (String(el.className).includes("shadow")) el.style.display = "none";
        }
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue?.includes("@") && !node.nodeValue.includes("hello@getuno")) {
          node.nodeValue = node.nodeValue.replace(/\S+@\S+\.\S+/g, "you@example.com");
        }
      }
    });
    await page.screenshot({ path: join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`) });
  };
  try {
    await openDemo(page, server.url, world);
    const note = await fn({ page, shot });
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("failed").catch(() => undefined);
  }
  await context.close();
}

const openHome = async (page) => {
  await page.getByRole("button", { name: "Home", exact: true }).first().click().catch(() => undefined);
  await page.waitForTimeout(900);
};

await step("sidebar-top", async ({ page, shot }) => {
  await openHome(page);
  await shot();
  if (!after) return;
  const pins = page.getByTestId("home-widget-pin");
  const count = await pins.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    await pins.nth(0).evaluate((button) => button.click());
    await page.waitForTimeout(300);
  }
  await page.getByTestId("sidebar-pin-row").waitFor();
  await shot("pinned");
  await page.getByTestId("sidebar-pin-row").getByRole("button").first().click();
  await page.getByTestId("pin-row-card").waitFor();
  await shot("card");
  return `${count} widgets can be pinned`;
});

await step("project-menu", async ({ page, shot }) => {
  const row = page.getByText("uno-api", { exact: false }).first();
  await row.click({ button: "right" });
  await page.waitForTimeout(500);
  await shot();
  if (!after) return;
  await page.getByText("Move to another computer…", { exact: true }).click();
  await page.getByText("Move project", { exact: true }).waitFor();
  await shot("dialog");
});

await step("bring-your-own", async ({ page, shot }) => {
  await page.getByText("Add a computer", { exact: false }).first().click();
  await page.waitForTimeout(500);
  await page.getByTestId("add-env-bring-your-own").waitFor();
  await shot();
});

await step(
  "fix-work",
  async ({ page, shot }) => {
    await page.getByTestId("sidebar-account").first().click();
    await page.getByTestId("sidebar-fix-work").waitFor();
    await shot("menu");
    await page.getByTestId("sidebar-fix-work").click();
    await page.waitForTimeout(400);
    await shot("dialog");
  },
  { only: true },
);

await step(
  "fix-work-letter",
  async ({ page, shot }) => {
    await page.getByText("Fix Work", { exact: true }).first().click();
    await page.getByText("Work stopped answering: disk full", { exact: false }).first().waitFor();
    await page.waitForTimeout(500);
    await shot();
  },
  { only: true },
);

await step(
  "update-everything",
  async ({ page, shot }) => {
    await page.goto(`${server.url}${new URL(page.url()).search}#/settings/about`);
    await page.waitForTimeout(900);
    await page.getByTestId("settings-update-everything").getByRole("button").first().click();
    await page.waitForTimeout(900);
    await shot();
  },
  { only: true },
);

await browser.close();
server.close();
writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
