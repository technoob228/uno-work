// The composer wave of 30.10 in the demo: each step starts on a clean browser,
// checks the behaviour and leaves a screenshot.
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/composer-shots.mjs <out-dir> [prefix]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { composer, dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/composer";
const prefix = process.argv[3] ?? "after";
mkdirSync(out, { recursive: true });

const server = await serve();
const browser = await launch();
const log = [];
const CLAUDE_CHATS = {
  newChatModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
};

async function step(name, world, fn, clientSettings) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  if (clientSettings) {
    await context.addInitScript((settings) => {
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    }, clientSettings);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (error) => log.push(`${name} pageerror: ${error.message.slice(0, 200)}`));
  const box = () => composer(page);
  const shot = async (label) => {
    await dismissBanners(page);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div,button")) {
        const text = (el.textContent ?? "").trim();
        if (text.length < 40 && /^(Что смотреть|What to look at)/.test(text)) {
          if (String(el.className).includes("shadow")) el.style.display = "none";
        }
      }
    });
    await page.screenshot({ path: join(out, `${prefix}-${name}${label ? `-${label}` : ""}.png`) });
  };
  const ctx = {
    page,
    box,
    shot,
    text: async () => (await box().innerText()).trim(),
    newChat: async () => {
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      await page.waitForTimeout(500);
      await box().click();
    },
  };
  try {
    await openDemo(page, server.url, world);
    const note = await fn(ctx);
    log.push(`ok ${name}${note ? `: ${note}` : ""}`);
  } catch (error) {
    log.push(`FAIL ${name}: ${String(error.message).split("\n")[0].slice(0, 240)}`);
    await shot("fail").catch(() => {});
  }
  await context.close();
}

await step("01-send-hint", {}, async ({ page, box, newChat, shot }) => {
  await newChat();
  await box().pressSequentially("Check the deploy");
  await shot();
  return `Send title: ${await page.locator('button[type="submit"]').last().getAttribute("title")}`;
});

await step("02-big-paste", {}, async ({ page, text, newChat, shot }) => {
  await newChat();
  await page.evaluate(() => {
    const target = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    const data = new DataTransfer();
    data.setData("text/plain", "log line\n".repeat(5000));
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(800);
  await shot();
  const now = await text();
  if (now.length > 1000) throw new Error(`the text stayed in the box: ${now.length} chars`);
  await page.getByText("pasted-text.txt").first().waitFor();
});

await step("03-stash", {}, async ({ page, box, text, newChat, shot }) => {
  await newChat();
  await box().pressSequentially("Rewrite the pricing page");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(500);
  await shot("aside");
  const after = await text();
  if (after.includes("Rewrite")) throw new Error(`the box wasn't cleared: "${after}"`);
  await page.getByText("Drafts", { exact: true }).first().waitFor();
  await page.getByText("Rewrite the pricing page").first().waitFor();
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(500);
  await shot("back");
  const back = await text();
  if (!back.includes("Rewrite")) throw new Error(`not restored, box: "${back}"`);
});

await step("04-background-send", {}, async ({ page, box, text, newChat, shot }) => {
  await newChat();
  await box().pressSequentially("Run the tests in the background");
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(1500);
  await shot();
  const now = await text();
  if (now.includes("Run the tests")) throw new Error(`still in the box: "${now}"`);
  await page.getByText("Started in the background").first().waitFor();
  const drafted = await page.getByText("Drafts", { exact: true }).count();
  if (drafted > 0) throw new Error("the sent chat stayed in Drafts");
  return page.evaluate(() => location.hash.split("/")[1]);
});

await step("05-drop", {}, async ({ page, newChat, shot }) => {
  await newChat();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    window.__dropData = data;
    for (const type of ["dragenter", "dragover"]) {
      document.body.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  });
  await page.waitForTimeout(300);
  await shot("overlay");
  await page.getByText("Drop to add to this chat").first().waitFor();
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new DragEvent("drop", { dataTransfer: window.__dropData, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(500);
  await page.getByText("notes.txt").first().waitFor();
  await shot("added");
});

await step(
  "06-limits",
  { plans: "full" },
  async ({ page, box, newChat, shot }) => {
    await newChat();
    await page.waitForTimeout(600);
    await shot("chip");
    await box().pressSequentially("/limits");
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    await shot("popover");
    await page
      .getByText(/resets|left/i)
      .first()
      .waitFor();
  },
  CLAUDE_CHATS,
);

await step("07-turn-into-project", {}, async ({ page, box, newChat, shot }) => {
  await newChat();
  await box().pressSequentially("Build a small site");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const row = page.locator("[data-thread-item]", { hasText: "Build a small site" }).first();
  const item = page.locator("button", { hasText: "Turn into project" }).first();
  // The demo's chat stays "working" a few seconds after its reply.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await row.click({ button: "right" });
    await page.waitForTimeout(400);
    if (await item.isEnabled().catch(() => false)) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
  }
  await shot("menu");
  await item.click();
  await page.waitForTimeout(700);
  await page.getByText("Turn this chat into a project").first().waitFor();
  await shot("dialog");
  await page.getByText("projects", { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Make .*project$/ }).click();
  await page.waitForTimeout(1200);
  await shot("done");
  return (
    await page
      .getByText(/project now|Couldn't make/)
      .first()
      .innerText()
  ).slice(0, 80);
});

await step("08-prompt-link", {}, async ({ page, text, shot }) => {
  // The demo's own query would join the hash route's: a link opens without it.
  const link = encodeURIComponent("Summarize this repo\u202e");
  await page.goto(`${server.url}#/new?prompt=${link}`);
  await page.waitForTimeout(3500);
  await shot();
  const now = await text();
  if (!now.includes("Summarize this repo")) throw new Error(`box: "${now}"`);
  await page.getByText("Nothing was sent", { exact: false }).first().waitFor();
  await page.getByText("hidden characters", { exact: false }).first().waitFor();
  return `box: ${now}, url ${await page.evaluate(() => location.hash.slice(0, 8))}`;
});

await step("09-prompt-link-keeps-draft", {}, async ({ page, box, text, newChat, shot }) => {
  await newChat();
  await box().pressSequentially("My own text");
  await page.evaluate(() => {
    location.hash = `#/new?prompt=${encodeURIComponent("From a link")}`;
  });
  await page.waitForTimeout(2500);
  await shot();
  const now = await text();
  if (!now.includes("My own text")) throw new Error(`draft lost, box: "${now}"`);
  await page.getByRole("button", { name: "Replace draft" }).first().click();
  await page.waitForTimeout(400);
  await shot("replaced");
  const replaced = await text();
  if (!replaced.includes("From a link")) throw new Error(`not replaced, box: "${replaced}"`);
  return `box: ${replaced}`;
});

writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
console.log(log.join("\n"));
await browser.close();
server.close();
process.exit(0);
