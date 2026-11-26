// Network → Proxy (26.11.2026): the person's own proxy as the exit, on a
// daemon without the tunnel yet (what ships first). Demo build of the real
// Work web client. Usage (after demo-e2e/build-demo.sh):
//   node demo-e2e/network-proxy-shots.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/network-proxy";
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
async function waitStatus(status) {
  await page
    .locator(`[data-testid="sidebar-network"][data-status="${status}"]`)
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
}
async function open(world) {
  await openDemo(page, server.url, { platform: "desktop", tunnel: "0", ...world });
  await network().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await dismissBanners(page);
  await page.addStyleTag({ content: '[data-testid="demo-panel-pill"]{display:none!important}' });
}

try {
  // 1. No proxy yet: the shield, the panel says "Add a proxy".
  await open({});
  await openPanel();
  await shot("p01-off-no-proxy");

  // 2. The form: SOCKS5 with a login, Check shows where sites see it.
  await page.getByTestId("network-row-exit").click();
  await page.getByTestId("network-proxy").waitFor();
  await settle();
  await shot("p02-form-empty");
  await page.getByRole("button", { name: "SOCKS5" }).click();
  await page.getByTestId("network-proxy-host").fill("de.proxy-seller.example");
  await page.getByTestId("network-proxy-port").fill("1080");
  await page.getByTestId("network-proxy-username").fill("misha");
  await page.getByTestId("network-proxy-password").fill("not-a-real-password");
  await page.getByTestId("network-proxy-check-button").click();
  await page.locator('[data-testid="network-proxy-check"][data-check="ok"]').waitFor();
  await settle();
  await shot("p03-form-checked");

  // 3. Use it: on, via proxy, Germany.
  await page.getByTestId("network-proxy-use").click();
  await page.getByTestId("network-headline").filter({ hasText: "via proxy" }).waitFor();
  await waitStatus("on");
  await shot("p04-on-panel");
  await closePanel();
  await shot("p05-on");

  // 4. The exit list: the proxy and "Edit proxy".
  await openPanel();
  await page.getByTestId("network-row-exit").click();
  await settle();
  await shot("p06-exits");
  await closePanel();

  // 5. The proxy stops answering: down, nothing goes around it.
  await open({ proxy: "down" });
  await shot("p07-down");
  await openPanel();
  await shot("p08-down-panel");
  await closePanel();

  // 6. A typo in the form: the daemon's sentence under it.
  await open({ proxy: "saved" });
  await openPanel();
  await page.getByTestId("network-row-exit").click();
  await page.getByTestId("network-proxy-edit").click();
  await page.getByTestId("network-proxy-host").fill("bad.proxy.example");
  await page.getByTestId("network-proxy-check-button").click();
  await page.locator('[data-testid="network-proxy-check"][data-check="failed"]').waitFor();
  await settle();
  await shot("p09-form-failed");
} finally {
  await browser.close();
  server.close();
}
