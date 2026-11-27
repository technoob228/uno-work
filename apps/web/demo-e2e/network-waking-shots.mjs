// Network, 0.0.199: the console lets an exit sleep after 3 days without
// devices and wakes it when a device asks; the panel says it's waking up
// instead of a red "doesn't answer", and the engine's reason names the
// protocol properly. Demo build of the real Work web client. Usage (after
// demo-e2e/build-demo.sh):
//   node demo-e2e/network-waking-shots.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/network-waking";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));

const CLIP = { x: 0, y: 0, width: 600, height: 680 };
async function shot(name) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, clip: CLIP });
  console.log(file);
}
const network = () => page.getByTestId("sidebar-network").first();
const settle = () => page.waitForTimeout(300);
async function openPanel() {
  await network().click();
  await page.getByTestId("network-panel").waitFor();
  await settle();
}
async function open(world) {
  await openDemo(page, server.url, { platform: "desktop", tunnel: "app", ...world });
  await network().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await dismissBanners(page);
  await page.addStyleTag({ content: '[data-testid="demo-panel-pill"]{display:none!important}' });
}

try {
  // 1. The engine's reason when the exit doesn't answer: the protocol by its name.
  await open({ net: "down", engine: "handshake" });
  await openPanel();
  await shot("w01-down-handshake");

  // 2. The cloud computer sleeps: the exit list says so.
  await open({ exit: "asleep" });
  await openPanel();
  await page.getByTestId("network-row-exit").click();
  await settle();
  await shot("w02-exit-asleep");

  // 3. Pick it: it wakes, the panel waits instead of going red.
  await page.getByTestId("network-exit-box-2531").click();
  await page.getByTestId("network-connecting").waitFor();
  await settle();
  await shot("w03-waking");
  await page
    .locator('[data-testid="sidebar-network"][data-status="on"]')
    .waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await shot("w04-awake-on");
} finally {
  await browser.close();
  server.close();
}
