// Another agent in a started chat (T3 port 30.10). Run it on two builds to compare:
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/handoff-shots.mjs <out-dir> before|after
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/handoff";
const prefix = process.argv[3] ?? "after";
const after = prefix === "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];

const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
const page = await context.newPage();
page.setDefaultTimeout(12_000);
page.on("pageerror", (error) => log.push(`pageerror: ${error.message.slice(0, 200)}`));

const clean = async () => {
  await dismissBanners(page);
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
};
const shot = async (name) => {
  await clean();
  await page.screenshot({ path: join(out, `${prefix}-${name}.png`) });
};
const step = async (name, fn) => {
  try {
    const note = await fn();
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot(`${name}-failed`).catch(() => undefined);
  }
};

const openPicker = () => page.locator('[data-chat-provider-model-picker="true"]').first().click();

try {
  await openDemo(page, server.url, { plans: "full" });
  await step("open-chat", async () => {
    await page.getByText("Signup form doesn").first().click();
    await page.locator('[contenteditable="true"]').last().waitFor();
    await page.waitForTimeout(1200);
    await shot("01-chat");
  });
  await step("picker", async () => {
    await openPicker();
    await page.waitForTimeout(900);
    await shot("02-picker");
    if (!after) return "locked to one agent";
    return await page.getByTestId("model-picker-note").innerText();
  });
  if (after) {
    await step("pick-agent", async () => {
      await page.locator('[data-model-picker-provider="claudeAgent"]').click();
      await page.waitForTimeout(700);
      await shot("02b-picker-claude");
      await page.getByText("Sonnet 5").first().click();
      await page.getByTestId("composer-agent-move").waitFor();
      await page.waitForTimeout(500);
      await shot("03-next-message-moves");
      return await page.getByTestId("composer-agent-move").innerText();
    });
    await step("keep", async () => {
      await page.getByTestId("composer-agent-keep").click();
      await page.getByTestId("composer-agent-move").waitFor({ state: "detached" });
    });
    await step("send", async () => {
      await openPicker();
      await page.waitForTimeout(500);
      await page.locator('[data-model-picker-provider="claudeAgent"]').click();
      await page.waitForTimeout(500);
      await page.getByText("Sonnet 5").first().click();
      await page.getByTestId("composer-agent-move").waitFor();
      const box = page.locator('[contenteditable="true"]').last();
      await box.click();
      await box.fill("Carry on with the fix, please");
      await page.keyboard.press("Enter");
      await page.getByTestId("agent-switch-line").waitFor();
      await page.waitForTimeout(3500);
      await shot("04-switched");
      return await page.getByTestId("agent-switch-line").innerText();
    });
  }
} finally {
  writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
  await context.close();
  await browser.close();
  server.close();
}
console.log(log.join("\n"));
