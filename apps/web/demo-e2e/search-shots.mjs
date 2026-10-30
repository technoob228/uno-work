// Message search, find in chat and goals on the real client (T3 port 30.10).
//   demo-e2e/build-demo.sh <dist> && DEMO_DIST=<dist> node demo-e2e/search-shots.mjs <out-dir> before|after
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/search";
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
  // Not the goal bar's Dismiss: `dismissBanners` clicks every such button.
  if ((await page.getByTestId("thread-goal-bar").count()) === 0) await dismissBanners(page);
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
const expectVisible = async (locator, what) => {
  await locator
    .first()
    .waitFor({ state: "visible", timeout: 6000 })
    .catch(() => {
      throw new Error(`not visible: ${what}`);
    });
};
const openChat = async (title) => {
  await page.getByText(title).first().click();
  await page.locator('[contenteditable="true"]').last().waitFor();
  await page.waitForTimeout(1000);
};
const palette = () => page.getByTestId("command-palette");
// Where the current match is: on screen, and not under the find bar.
const activePlace = () =>
  page.evaluate(() => {
    const range = [...(CSS.highlights?.get("uno-thread-find-active") ?? [])][0];
    const bar = document.querySelector("[data-thread-find-bar]")?.getBoundingClientRect();
    if (!range || !bar) return null;
    const rect = range.getBoundingClientRect();
    const composer = document.querySelector('[contenteditable="true"]')?.getBoundingClientRect();
    return {
      belowBar: rect.top >= bar.bottom,
      aboveComposer: composer ? rect.bottom <= composer.top : true,
      text: range.toString(),
    };
  });
const highlights = () =>
  page.evaluate(() => ({
    all: CSS.highlights?.get("uno-thread-find")?.size ?? 0,
    active: CSS.highlights?.get("uno-thread-find-active")?.size ?? 0,
  }));

try {
  await openDemo(page, server.url, {});

  await step("palette-search", async () => {
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(500);
    if (!(await palette().isVisible())) {
      await page
        .getByRole("button", { name: /^Search/ })
        .first()
        .click();
    }
    await expectVisible(palette(), "command palette");
    // Only inside a message, never in a chat's title.
    await page.keyboard.type("welcome email");
    await page.waitForTimeout(900);
    await shot("01-palette-message-search");
    const text = await palette().innerText();
    if (!after) return `palette finds it: ${text.includes("welcome email")}`;
    if (!text.includes("Messages")) throw new Error("no Messages group");
    if (!text.includes("welcome email")) throw new Error("no snippet");
    return "Messages group with the snippet";
  });

  if (after) {
    await step("palette-opens-the-message", async () => {
      await page.keyboard.press("Enter");
      await expectVisible(page.getByTestId("thread-find-input"), "find bar on the jump");
      await page.waitForTimeout(1000);
      await shot("02-opened-on-the-message");
      const marks = await highlights();
      const query = await page.getByTestId("thread-find-input").inputValue();
      if (marks.active !== 1) throw new Error(`active highlight ${JSON.stringify(marks)}`);
      const place = await activePlace();
      if (!place?.belowBar) throw new Error(`match under the bar ${JSON.stringify(place)}`);
      return `${JSON.stringify(marks)}, query "${query}", ${page.url().split("#")[1] ?? ""}`;
    });
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await step("find-in-chat", async () => {
    await openChat("Signup form doesn");
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(500);
    if (!after) {
      await shot("03-find-in-chat");
      return `bar present: ${await page.getByTestId("thread-find-input").count()}`;
    }
    await expectVisible(page.getByTestId("thread-find-input"), "find bar");
    await page.keyboard.type("form");
    await page.waitForTimeout(900);
    await shot("03-find-in-chat");
    const bar = page
      .getByRole("search", { name: "Find in chat" })
      .or(page.locator('[aria-label="Find in chat"]').first());
    const counter = (await bar.first().innerText()).replace(/\s+/g, " ");
    const first = await highlights();
    if (first.all < 2) throw new Error(`highlights ${JSON.stringify(first)}`);
    if (first.active !== 1) throw new Error(`no current match ${JSON.stringify(first)}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const moved = (await bar.first().innerText()).replace(/\s+/g, " ");
    await shot("04-find-next");
    if (moved === counter) throw new Error(`Enter did not move: ${moved}`);
    return `${JSON.stringify(first)}, "${counter}" -> "${moved}"`;
  });

  if (after) {
    await step("every-match-comes-into-view", async () => {
      // A short window: most matches start off screen, one in a folded turn.
      await page.setViewportSize({ width: 1280, height: 460 });
      await page.waitForTimeout(600);
      const seen = [];
      for (let index = 0; index < 7; index += 1) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(700);
        const place = await activePlace();
        seen.push(place ? (place.belowBar && place.aboveComposer ? "ok" : "hidden") : "none");
      }
      await shot("04b-short-window");
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.waitForTimeout(400);
      if (seen.includes("hidden") || seen.includes("none")) throw new Error(seen.join(" "));
      return seen.join(" ");
    });

    await step("esc-returns-to-composer", async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      if ((await page.getByTestId("thread-find-input").count()) !== 0) {
        throw new Error("bar still open");
      }
      const editable = await page.evaluate(
        () => document.activeElement?.getAttribute("contenteditable") === "true",
      );
      if (!editable) throw new Error("focus is not in the composer");
    });

    await step("find-leaves-files-alone", async () => {
      await page.getByTestId("sidebar-places").getByRole("button").nth(1).click();
      await page.waitForTimeout(1500);
      await page.getByTestId("panel-files-tab").click({ position: { x: 200, y: 500 } });
      await page.keyboard.press("Meta+f");
      await page.waitForTimeout(500);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      const open = await page.getByTestId("thread-find-input").count();
      await shot("05-find-in-files-panel");
      if (open !== 0) throw new Error("chat find took the shortcut from Files");
      if (focused !== "Search files") throw new Error(`focus went to ${focused}`);
      return `focus: ${focused}, chat find closed`;
    });

    await step("find-back-in-the-chat", async () => {
      await page.getByTestId("sidebar-places").getByRole("button").nth(1).click();
      await page.waitForTimeout(800);
      await openChat("Signup form doesn");
      await page.locator('[contenteditable="true"]').last().click();
      await page.keyboard.press("Meta+f");
      await expectVisible(page.getByTestId("thread-find-input"), "find bar from the composer");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    });
  }

  await step("goal", async () => {
    await openChat("Signup form doesn");
    const composer = page.locator('[contenteditable="true"]').last();
    await composer.click();
    await page.keyboard.type("/goal");
    await page.waitForTimeout(700);
    await shot("06-goal-in-the-menu");
    if (!after) return "no goal command before";
    await page.keyboard.type(" make the signup email arrive");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await expectVisible(page.getByTestId("thread-goal-bar"), "goal status line");
    await page.waitForTimeout(600);
    await shot("07-goal-running");
    const line = (await page.getByTestId("thread-goal-bar").innerText()).replace(/\s+/g, " ");
    await page.getByTestId("thread-goal-bar").getByRole("button", { name: /Stop/ }).click();
    await page.waitForTimeout(150);
    await page.waitForTimeout(650);
    await shot("08-goal-stopped");
    const ended = (await page.getByTestId("thread-goal-bar").innerText()).replace(/\s+/g, " ");
    return `"${line}" -> "${ended}"`;
  });
} finally {
  writeFileSync(join(out, `${prefix}-log.txt`), `${log.join("\n")}\n`);
  console.log(log.join("\n"));
  await browser.close();
  server.close();
}
