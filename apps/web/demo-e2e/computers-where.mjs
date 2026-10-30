// Which computer is on screen (Misha 30.10): a chat names its own computer; Home
// sets none apart: its picker places a new chat, its Terminal asks where.
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
expect("New chat starts on", await text("home-computer-chip"), "uno-work");
const pill = page.getByTestId("home-computer-pill");
expect("Home's chip names uno-work", await pill.innerText(), "uno-work");
expect("Home's chip names MacBook", await pill.innerText(), "MacBook");
expect("Terminal on Home has no computer", await text("home-terminal"), "Terminal");
expect(
  "Terminal on Home names none",
  String((await text("home-terminal")).includes("uno-work")),
  "false",
);
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
expect("Opening a chat leaves Home's picker alone", await text("home-computer-chip"), "uno-work");

// The chip's menu on Home tags no computer as chosen.
await pill.click();
await page.waitForTimeout(800);
const menu = await text("computers-menu");
expect("No computer is tagged", String(menu.includes("selected")), "false");
expect(
  "No terminal in the rows",
  String(await page.getByTestId("computers-row-terminal").count()),
  "0",
);
await shot("3-chip-rows");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// Terminal asks where, and the answer does not move the new chat's computer.
await page.getByTestId("home-terminal").click();
await page.waitForTimeout(600);
const options = page.getByTestId("home-terminal-option");
expect("Terminal offers uno-work", await options.allInnerTexts(), "uno-work");
expect("Terminal offers MacBook", await options.allInnerTexts(), "MacBook");
await shot("4-terminal-choice");
await options.filter({ hasText: "MacBook" }).click();
await page.waitForTimeout(3500);
await dismissBanners(page);
expect("The new chat is on", await text("new-chat-computer-picker"), "MacBook");
expect(
  "The chat header says",
  await page.getByTestId("chat-computer-chip").first().innerText(),
  "MacBook",
);
expect("The terminal says", await text("terminal-computer"), "MacBook");
await shot("5-terminal-on-macbook");

await go("#/computer");
expect("Terminal's pick leaves Home's picker alone", await text("home-computer-chip"), "uno-work");
await page.getByTestId("home-terminal").click();
await page.waitForTimeout(600);
await page.getByTestId("home-terminal-option").filter({ hasText: "uno-work" }).click();
await page.waitForTimeout(3500);
await dismissBanners(page);
expect("The other choice opens on", await text("terminal-computer"), "uno-work");
await shot("6-terminal-on-uno-work");

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
if (out) await spaces.screenshot({ path: `${out}/7-space-macbook-home.png` });
await spaces.getByTestId("home-terminal").click();
await spaces.waitForTimeout(3500);
await dismissBanners(spaces);
expect(
  "Spaces: Terminal opens right on the space's computer",
  await spaces.getByTestId("terminal-computer").first().innerText(),
  "MacBook",
);

await browser.close();
server.close();
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "all good");
process.exit(fails.length ? 1 : 0);
