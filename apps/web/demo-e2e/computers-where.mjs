// Which computer is on screen (Misha 30.10): a chat names its own computer, and
// outside a chat Home's picker decides where a new chat and Terminal go.
//   node demo-e2e/computers-where.mjs [shots-dir]
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
const text = (id) => page.getByTestId(id).first().innerText();
const go = async (hash) => {
  await page.evaluate((target) => {
    location.hash = target;
  }, hash);
  await page.waitForTimeout(2000);
};

await openDemo(page, server.url, { mac: "online" });
await page.waitForTimeout(2500);
await dismissBanners(page);

await page.getByTestId("home-terminal").waitFor({ timeout: 20_000 });
expect("Home starts on", await text("home-computer-chip"), "uno-work");
expect("Terminal on Home says", await text("home-terminal"), "uno-work");
await shot("1-home");

const macbook = await page.evaluate(() => window.__assistDemo.environmentOf("mac"));
await go(`#/${macbook}/m-deck`);
await dismissBanners(page);
const chip = page.getByTestId("chat-computer-chip").first();
expect("A MacBook chat's chip", await chip.innerText(), "MacBook");
expect("Its tooltip", await chip.getAttribute("title"), "This chat runs on MacBook");
expect("The others are just dots", String((await chip.innerText()).includes("uno-work")), "false");
await shot("2-macbook-chat");

await go("#/computer");
expect("Opening a chat leaves Home's computer alone", await text("home-computer-chip"), "uno-work");

await page.getByTestId("home-computer-chip").click();
await page.getByTestId("new-chat-computer-option").getByText("MacBook").click();
await page.waitForTimeout(1500);
expect("Picked on Home", await text("home-computer-chip"), "MacBook");
expect("Terminal follows the pick", await text("home-terminal"), "MacBook");
await shot("3-home-picked-macbook");

await page.getByTestId("home-terminal").click();
await page.waitForTimeout(3500);
await dismissBanners(page);
expect("The new chat is on", await text("new-chat-computer-picker"), "MacBook");
expect(
  "The chat header says",
  await page.getByTestId("chat-computer-chip").first().innerText(),
  "MacBook",
);
expect("The terminal says", await text("terminal-computer"), "MacBook");
await shot("4-terminal-on-macbook");

// Any computer's terminal from the chip, whatever is picked.
await go("#/computer");
await page.getByTestId("home-computer-pill").click();
await page.waitForTimeout(800);
await shot("5-chip-rows");
const rows = page.getByTestId("computers-row");
await rows.filter({ hasText: "uno-work" }).getByTestId("computers-row-terminal").click();
await page.waitForTimeout(3500);
await dismissBanners(page);
expect("The chip's Terminal opened on", await text("terminal-computer"), "uno-work");
await shot("6-terminal-from-chip");

// Spaces: a space is its computer.
const spaces = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();
await openDemo(spaces, server.url, { mac: "online", spaces: "on" });
await spaces.waitForTimeout(2500);
await dismissBanners(spaces);
await spaces.getByTestId("home-terminal").waitFor({ timeout: 20_000 });
expect(
  "Spaces: no picker on Home",
  String(await spaces.getByTestId("home-computer-chip").count()),
  "0",
);
await spaces.getByTestId("home-computer-pill").click();
await spaces.waitForTimeout(800);
await spaces.getByTestId("computers-row-switch").first().click();
await spaces.waitForTimeout(3000);
await dismissBanners(spaces);
expect("Spaces: a switch lands on Home", spaces.url(), "#/computer");
expect(
  "Spaces: Terminal is the space's",
  await spaces.getByTestId("home-terminal").innerText(),
  "MacBook",
);
if (out) await spaces.screenshot({ path: `${out}/7-space-macbook-home.png` });

await browser.close();
server.close();
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "all good");
process.exit(fails.length ? 1 : 0);
