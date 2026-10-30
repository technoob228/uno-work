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

const STEPS = process.env.STEPS?.split(",") ?? null;

async function step(name, fn, { only = false, world = {} } = {}) {
  if (only && !after) return;
  if (STEPS && !STEPS.includes(name)) return;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(40_000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  const shot = async (label, { keepDialog = false } = {}) => {
    // "Not now" is also the update dialog's own way out.
    if (!keepDialog) await dismissBanners(page);
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
  await page
    .getByRole("button", { name: "Home", exact: true })
    .first()
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(900);
};

await step("sidebar-top", async ({ page, shot }) => {
  await shot();
  if (!after) return;
  for (const widget of ["Uno AI", "Cloud", "Sites"]) {
    await page
      .getByText("Customize widgets")
      .first()
      .click()
      .catch(() => undefined);
    await page.getByRole("button", { name: "Add widget" }).click();
    await page
      .getByRole("button", { name: new RegExp(`^${widget}`) })
      .first()
      .click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Done", exact: true }).last().click();
  await page.waitForTimeout(500);
  const pins = page.getByTestId("home-widget-pin");
  const count = await pins.count();
  for (let index = 0; index < count; index += 1) {
    await pins.nth(index).evaluate((button) => button.click());
    await page.waitForTimeout(300);
  }
  await page.getByTestId("sidebar-pin-row").waitFor();
  await page.mouse.move(800, 300);
  if (await page.getByTestId("sidebar-d-pinned").isVisible()) {
    throw new Error("the list of pins is shown for pins that live in the row");
  }
  await shot("pinned");
  await page.getByTestId("sidebar-pin-row").getByRole("button").first().click();
  await page.getByTestId("pin-row-card").waitFor();
  await page.waitForTimeout(500);
  await shot("card");
  return `${count} widgets pinned`;
});

await step("project-menu", async ({ page, shot }) => {
  await page.getByText("All chats", { exact: true }).first().click();
  await page.getByText("By project", { exact: true }).click();
  await page.waitForTimeout(600);
  await shot("list");
  const row = page.getByText(process.env.DEMO_PROJECT ?? "landing", { exact: false }).first();
  await row.click({ button: "right" });
  await page.waitForTimeout(500);
  await shot();
  if (!after) return;
  await page.getByText("Move to another computer…", { exact: true }).click();
  await page.getByText("From uno-work", { exact: true }).click();
  await page.getByRole("button", { name: "Move project" }).waitFor();
  await page.waitForTimeout(400);
  await shot("dialog");
});

await step("bring-your-own", async ({ page, shot }) => {
  await page.getByText("Details", { exact: false }).first().click();
  await page.getByText("Add computer", { exact: true }).first().click();
  await page.getByText("Bring your own", { exact: true }).first().waitFor();
  await page.waitForTimeout(400);
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
    await page.getByTestId("sidebar-account").first().click();
    await page.getByText("Settings", { exact: true }).first().click();
    await page.getByText("About", { exact: true }).first().click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.getByText("Update everything", { exact: true }).last().waitFor();
    await page.waitForTimeout(1200);
    await shot("", { keepDialog: true });
  },
  { only: true },
);

await browser.close();
server.close();
writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
