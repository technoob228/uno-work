// Which AI for which task (13.11): ROUTING.md on the assistant's page,
// Environment tab - the table with buttons, then the file itself.
// Usage (after demo-e2e/build-demo.sh): node demo-e2e/routing-shots.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/routing";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

async function shot(name) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}

try {
  await openDemo(page, server.url, { platform: "desktop" });
  await page.addStyleTag({ content: '[data-testid="demo-panel-pill"]{display:none!important}' });
  // The desktop app's "Make this Mac one of your computers?" would cover the table.
  const later = page.getByTestId("lc-this-mac-later");
  if (await later.isVisible().catch(() => false)) await later.click();
  // Uno's page from the team list, its Environment tab.
  await page.evaluate(() => {
    location.hash = "#/assistants";
  });
  await page.getByTestId("assistants-team-row").first().click();
  await page.getByTestId("assistant-profile-tab-where").click();
  const models = page.getByTestId("assistant-profile-models");
  await models.waitFor({ timeout: 20_000 });
  await page.getByTestId("assistant-models-table").waitFor({ timeout: 20_000 });
  await models.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await shot("01-table");

  await page.getByTestId("assistant-models-file-toggle").click();
  await page.getByTestId("assistant-models-file-text").waitFor();
  await models.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot("02-file");
} finally {
  await browser.close();
  server.close();
}
