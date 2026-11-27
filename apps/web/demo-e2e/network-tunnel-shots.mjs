// Network tunnel at app level (27.11.2026): Uno Work's own apps go through
// uno-net to the account's cloud computer or a pasted WireGuard config; the
// panel says honestly what goes direct. Demo build of the real Work web
// client. Usage (after demo-e2e/build-demo.sh):
//   node demo-e2e/network-tunnel-shots.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/network-tunnel";
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
async function closePanel() {
  await page.keyboard.press("Escape");
  await settle();
}
async function open(world) {
  await openDemo(page, server.url, { platform: "desktop", tunnel: "app", ...world });
  await network().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await dismissBanners(page);
  await page.addStyleTag({ content: '[data-testid="demo-panel-pill"]{display:none!important}' });
}

const CONF = `[Interface]
PrivateKey = (your key)
Address = 10.8.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = hR1nGq0x6v1pX0kLw2cXo3s4b5t6u7v8w9x0y1z2A3B=
Endpoint = vpn.example.net:51820
AllowedIPs = 0.0.0.0/0`;

try {
  // 1. Off: the exit is the account's cloud computer.
  await open({});
  await openPanel();
  await shot("t01-off");

  // 2. The exits: your cloud computer, Uno addresses soon, paste a config, your proxy.
  await page.getByTestId("network-row-exit").click();
  await settle();
  await shot("t02-exits");

  // 3. Pick it: Uno sets it up, then on, with the honest line about what goes direct.
  await page.getByTestId("network-exit-box-2531").click();
  await page.getByTestId("network-connecting").waitFor();
  await shot("t03-setting-up");
  await page.locator('[data-testid="sidebar-network"][data-status="on"]').waitFor();
  await page.waitForTimeout(600);
  await shot("t04-on");
  await closePanel();

  // 4. Paste a WireGuard config from your own server or a VPN provider.
  await openPanel();
  await page.getByTestId("network-row-exit").click();
  await page.getByTestId("network-import-open").click();
  await page.getByTestId("network-import-conf").fill(CONF);
  await page.getByTestId("network-import-label").fill("Home server");
  await settle();
  await shot("t05-import");
  await page.getByTestId("network-import-use").click();
  await page.locator('[data-testid="sidebar-network"][data-status="on"]').waitFor();
  await page.waitForTimeout(600);
  await page.getByTestId("network-row-exit").click();
  await settle();
  await shot("t06-imported");
  await closePanel();

  // 5. The exit stops answering: Uno Work's apps go offline, not direct.
  await open({ net: "down" });
  await openPanel();
  await shot("t07-down");
} finally {
  await browser.close();
  server.close();
}
