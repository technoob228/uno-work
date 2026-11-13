// Network (12.11.2026): the switch on top of the sidebar, on the demo build of
// the real Work web client. Usage (after demo-e2e/build-demo.sh):
//   node demo-e2e/network-shots.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/network";
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
const network = () => page.getByTestId("sidebar-network").first();
const settle = () => page.waitForTimeout(300);
async function openPanel() {
  await network().click();
  await page.getByTestId("network-panel").waitFor();
  await settle();
}
async function closePanel() {
  await page.keyboard.press("Escape");
  await settle();
}
async function waitOn() {
  // A change shows "connecting" first; wait for it to pass.
  await page
    .locator('[data-testid="sidebar-network"][data-status="connecting"]')
    .waitFor({ timeout: 3_000 })
    .catch(() => undefined);
  await page
    .locator('[data-testid="sidebar-network"][data-status="on"]')
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_200);
}

async function open(world) {
  await openDemo(page, server.url, { platform: "desktop", ...world });
  await network().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await dismissBanners(page);
  // The demo's own "what to look at" pill isn't part of Work.
  await page.addStyleTag({ content: '[data-testid="demo-panel-pill"]{display:none!important}' });
}

try {
  // 1. Off: a shield next to Search.
  await open({ net: "off" });
  await shot("01-off");
  await openPanel();
  await shot("02-off-panel");

  // 2. Turn it on: Connecting… then on, Germany, Auto · WireGuard.
  await page.getByTestId("network-switch").click();
  await page.waitForTimeout(250);
  await shot("03-connecting");
  await waitOn();
  await shot("04-on-panel");
  await closePanel();
  await shot("05-on");

  // 3. Protocol: the list, then AmneziaWG.
  await openPanel();
  await page.getByTestId("network-row-protocol").click();
  await settle();
  await shot("06-protocols");
  await page.getByTestId("network-protocol-amneziawg").click();
  await waitOn();
  await shot("07-amneziawg");

  // 4. Exit: the list, then own server.
  await page.getByTestId("network-row-exit").click();
  await settle();
  await shot("08-exits");
  await page.getByTestId("network-exit-srv-ams").click();
  await waitOn();
  await shot("09-own-server");
  await closePanel();

  // 5. This Mac is already on a corporate VPN.
  await open({ net: "on", vpn: "cisco" });
  await openPanel();
  await shot("10-other-vpn");
  await closePanel();

  // 6. First time on this Mac: macOS asks once; until then Uno Work waits offline.
  await open({ net: "off", perm: "ask" });
  await openPanel();
  await page.getByTestId("network-switch").click();
  await page.getByTestId("network-permission").waitFor();
  await page.waitForTimeout(1_200);
  await shot("11-permission");
  await page.getByTestId("network-allow").click();
  await waitOn();
  await shot("12-permission-allowed");
  await closePanel();

  // 7. The exit doesn't answer.
  await open({ net: "down" });
  await shot("13-down");
  await openPanel();
  await shot("14-down-panel");
  await closePanel();

  // 8. Collapsed sidebar: the shield in the rail.
  await open({ net: "on" });
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(600);
  await shot("15-rail");
} finally {
  await browser.close();
  server.close();
}
