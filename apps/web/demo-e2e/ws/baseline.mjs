// Baseline shots of today's Work (before the workspace vision) on the demo build.
import { launch, openDemo, serve, SHOTS, dismissBanners, openMainChat } from "../harness.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const out = join(SHOTS, "ws-baseline");
mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await openDemo(page, server.url, {
  fleet: "on",
  pair: "on",
  plans: "full",
  ws: process.env.WS ?? "off",
});
await page.waitForTimeout(2500);
await dismissBanners(page);
await page.screenshot({ path: join(out, "home.png") });
for (const h of ["/computer", "/my-uno", "/assistants", "/app", "/sites", "/drive", "/files"]) {
  await page.evaluate((x) => (location.hash = "#" + x), h);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(out, h.replace(/\//g, "_") + ".png") });
}
await openMainChat(page, "work");
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, "chat-uno.png") });
console.log("errors", errors.slice(0, 5));
await browser.close();
server.close();
