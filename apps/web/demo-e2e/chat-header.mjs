// The chat's header (Misha 30.10): Terminal for everyone; Automations live in
// the Panel, and a clock joins the header once the chat has some.
//   node demo-e2e/chat-header.mjs [shots-dir]
import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? null;
const server = await serve();
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const shot = async (name) => {
  if (out) await page.screenshot({ path: `${out}/${name}.png` });
};
const fails = [];
const expect = (what, got, want) => {
  const ok = String(got).includes(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}`);
  if (!ok) fails.push(what);
};
const go = async (hash) => {
  await page.evaluate((target) => {
    location.hash = target;
  }, hash);
  await page.waitForTimeout(2500);
  await dismissBanners(page);
};
const count = (id) => page.getByTestId(id).count();
// With a tab open, Panel shows the tab; "+" shows the launcher.
const openLauncher = async () => {
  if ((await count("panel-launcher")) > 0) return;
  await page.getByTestId("panel-launcher-open").click();
  await page.waitForTimeout(800);
};

await openDemo(page, server.url, { mac: "online", automations: "some" });
await page.waitForTimeout(2500);
await dismissBanners(page);
const cloud = await page.evaluate(() => window.__assistDemo.environmentOf("work"));
const macbook = await page.evaluate(() => window.__assistDemo.environmentOf("mac"));

// A chat with an automation: the clock is in the header, with the count.
await go(`#/${cloud}/w-export`);
const clock = page.getByTestId("chat-automations-button");
expect("A chat with automations has the clock", await clock.count(), "1");
expect("The clock counts them", await clock.innerText(), "4");
await shot("h1-chat-with-automation");
await clock.click();
await page.waitForTimeout(600);
await page.getByTestId("chat-automation-edit").first().click();
await page.waitForTimeout(800);
expect("Edit opens the dialog", await page.getByRole("dialog").count(), "1");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// A chat without: no clock; the Panel has them.
await go(`#/${cloud}/w-checkout`);
expect("A chat without has no clock", await count("chat-automations-button"), "0");
const terminal = page.getByRole("button", { name: "Toggle terminal drawer" });
expect("Terminal is in the header without Dev mode", await terminal.count(), "1");
await shot("h2-chat-without");
await page.getByTestId("preview-panel-toggle").click();
await page.waitForTimeout(1200);
await openLauncher();
await shot("h3-panel-tiles");
await page.getByTestId("panel-launcher-automations").click();
await page.waitForTimeout(800);
expect("The Panel's list says it is empty", await count("chat-automations-empty"), "1");
await shot("h4-panel-automations");
await page.getByTestId("chat-automations-new").click();
await page.waitForTimeout(800);
expect("New automation opens from the Panel", await page.getByRole("dialog").count(), "1");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await page.getByTestId("preview-panel-toggle").click();
await page.waitForTimeout(600);

await terminal.click();
await page.waitForTimeout(1500);
expect(
  "Terminal opens on the chat's computer",
  await page.getByTestId("terminal-computer").first().innerText(),
  "uno-work",
);
await shot("h5-terminal");
await terminal.click();
await page.waitForTimeout(500);

// A chat on the MacBook: Automations run on a cloud computer.
await go(`#/${macbook}/m-deck`);
expect("MacBook: no clock", await count("chat-automations-button"), "0");
await page.getByTestId("preview-panel-toggle").click();
await page.waitForTimeout(1200);
await openLauncher();
expect("MacBook: the Panel's list is there", await count("panel-launcher-list"), "1");
expect("MacBook: no Automations in the Panel", await count("panel-launcher-automations"), "0");
await shot("h6-macbook-panel");

await browser.close();
server.close();
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "all good");
process.exit(fails.length ? 1 : 0);
