// A client's walk through the assistants (29.10, Misha: "I couldn't go back and
// change an assistant's settings"). Runs the same steps on any demo build and
// keeps going when a step fails, so a "before" and an "after" build give
// screenshots of the same moments:
//   DEMO_DIST=<build> WALK_OUT=<dir> node demo-e2e/ux-walk.mjs [desktop|mobile|asks]
// Every step writes <WALK_OUT>/<id>.png and a line in <WALK_OUT>/walk.json:
// where the page is, the header's buttons with their hover text, notes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { dismissBanners, openDemo, serve } from "./harness.mjs";

const OUT = process.env.WALK_OUT ?? "/tmp/ux-walk";
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ?? "all";
const log = [];

const server = await serve();
const browser = await chromium.launch({ headless: true });

const where = (page) => {
  const url = new URL(page.url());
  return decodeURIComponent(url.hash || url.pathname);
};

/** `full`: the page scrolls inside the app, so a tall window shows all of it. */
async function snap(page, id, full = false) {
  await page.waitForTimeout(500);
  const size = page.viewportSize();
  if (full && size) {
    await page.setViewportSize({ width: size.width, height: 2600 });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: join(OUT, `${id}.png`) });
  if (full && size) await page.setViewportSize(size);
}

/** The visible buttons of the open page's top bar, with what hovering them says. */
async function headerButtons(page) {
  const anchor = page
    .locator(
      '[data-testid="uno-headline"], [data-testid="teammate-headline"], [data-testid="chat-done-button"]',
    )
    .first();
  if ((await anchor.count()) === 0) return [];
  const bar = anchor.locator("xpath=ancestor::header[1]");
  const target = (await bar.count()) > 0 ? bar : anchor.locator("xpath=../..");
  const buttons = target.locator("button:visible, [role=button]:visible");
  const out = [];
  const n = await buttons.count();
  for (let i = 0; i < n; i += 1) {
    const button = buttons.nth(i);
    const label = (
      (await button.getAttribute("aria-label")) ||
      (await button.innerText().catch(() => "")) ||
      (await button.getAttribute("title")) ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const testId = (await button.getAttribute("data-testid")) ?? "";
    let hover = "";
    try {
      await button.hover({ timeout: 2000 });
      await page.waitForTimeout(450);
      const tip = page.locator('[data-slot="tooltip-popup"]:visible').last();
      if ((await tip.count()) > 0) hover = (await tip.innerText()).replace(/\s+/g, " ").trim();
      if (!hover) hover = (await button.getAttribute("title")) ?? "";
    } catch {
      /* not hoverable */
    }
    out.push({ label, testId, hover });
  }
  await page.mouse.move(5, 450);
  return out;
}

async function run(page, id, title, expected, fn) {
  const entry = { id, title, expected };
  try {
    const note = await fn();
    entry.ok = true;
    if (note) entry.note = note;
  } catch (error) {
    entry.ok = false;
    entry.error = String(error?.message ?? error)
      .split("\n")[0]
      .slice(0, 300);
    await snap(page, `${id}-fail`).catch(() => undefined);
  }
  entry.url = where(page);
  log.push(entry);
  console.log(`${entry.ok ? "✓" : "✗"} ${id} ${title}${entry.error ? ` — ${entry.error}` : ""}`);
}

const row = (page, projectId) =>
  page.locator(`[data-testid="sidebar-assistant"][data-assistant="${projectId}"]`);

async function sidebarNames(page) {
  return page
    .getByTestId("sidebar-assistant")
    .evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()));
}

async function headingText(page) {
  return page
    .locator("main h1, [data-slot=sidebar-inset] h1, h1")
    .first()
    .innerText()
    .catch(() => "");
}

/** Back to the app's start with the sidebar (as a person would click the logo). */
async function home(page) {
  if (
    await page
      .getByTestId("sidebar-assistants")
      .isVisible()
      .catch(() => false)
  )
    return;
  await page.evaluate(() => window.__assistDemo.go("/", {}));
  await page.getByTestId("sidebar-assistants").waitFor({ timeout: 10_000 });
}

async function desktop() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);

  await run(
    page,
    "d01-sidebar",
    "Find assistants in the sidebar",
    "A clear Assistants block: Uno + my helpers",
    async () => {
      await openDemo(page, server.url);
      await page.getByTestId("sidebar-assistants").waitFor();
      await snap(page, "d01-sidebar");
      return { rows: await sidebarNames(page) };
    },
  );

  await run(
    page,
    "d02-gear",
    "Gear next to Assistants → where does it lead",
    "Settings of my assistants (each one's name, mode, Telegram…)",
    async () => {
      const gear = page.getByTestId("sidebar-assistants-settings");
      await gear.hover();
      await page.waitForTimeout(500);
      const tip = await page
        .locator('[data-slot="tooltip-popup"]:visible')
        .last()
        .innerText()
        .catch(() => "");
      await gear.click();
      await page.waitForTimeout(1200);
      await snap(page, "d02-gear");
      return { tooltip: tip, heading: await headingText(page) };
    },
  );

  await run(
    page,
    "d03-list",
    "From there: the Assistants list",
    "A list of my assistants; click one → its settings",
    async () => {
      const link = page
        .getByText(/Bots that answer|All your assistants|See all assistants/)
        .first();
      if ((await link.count()) > 0) await link.click();
      await page.waitForTimeout(1200);
      await snap(page, "d03-list");
      return { heading: await headingText(page) };
    },
  );

  await run(
    page,
    "d04-list-open",
    "Click the first assistant in that list",
    "Its settings page",
    async () => {
      const first = page
        .locator(
          '[data-testid="assistants-list"] button, [data-testid="assistants-list"] [role=button], [data-testid="assistants-list"] a',
        )
        .first();
      await first.click();
      await page.waitForTimeout(1200);
      await snap(page, "d04-list-open", true);
      return { heading: await headingText(page) };
    },
  );

  await run(
    page,
    "d05-mia-chat",
    "Open Mia (a helper) from the sidebar",
    "Its chat with a clear header",
    async () => {
      await home(page);
      await row(page, "assistant-mia").getByTestId("sidebar-assistant-open").click();
      await page.waitForTimeout(1500);
      await snap(page, "d05-mia-chat");
      return { header: await headerButtons(page) };
    },
  );

  await run(
    page,
    "d06-mia-settings",
    "From Mia's chat: open its settings",
    "One obvious Settings button in the header",
    async () => {
      const explicit = page.getByTestId("assistant-header-settings");
      if ((await explicit.count()) > 0) await explicit.first().click();
      else await page.getByTestId("teammate-headline").click();
      await page.getByTestId("assistant-profile").waitFor();
      await snap(page, "d06-mia-settings", true);
      return { heading: await headingText(page), explicitButton: (await explicit.count()) > 0 };
    },
  );

  await run(
    page,
    "d07-uno-chat",
    "Open Uno from the sidebar",
    "Uno's chat; header buttons say what they do",
    async () => {
      await home(page);
      await page
        .getByTestId("sidebar-assistant")
        .first()
        .getByTestId("sidebar-assistant-open")
        .click();
      await page.waitForTimeout(1500);
      await snap(page, "d07-uno-chat");
      return { header: await headerButtons(page) };
    },
  );

  await run(
    page,
    "d08-uno-settings",
    "From Uno's chat: open Uno's settings",
    "A Settings button → Uno's page (mode, Telegram, apps, AI)",
    async () => {
      const explicit = page.getByTestId("assistant-header-settings");
      if ((await explicit.count()) > 0) {
        await explicit.first().click();
      } else {
        // The only door there is: Memory ▸ "settings" in its popup.
        await page.getByTestId("uno-memory").click();
        await page.waitForTimeout(400);
        await snap(page, "d08a-uno-memory-popup");
        await page.getByTestId("uno-memory-settings").click();
      }
      await page.waitForTimeout(1500);
      await snap(page, "d08-uno-settings", true);
      return { heading: await headingText(page), explicitButton: (await explicit.count()) > 0 };
    },
  );

  await run(page, "d09-uno-face", "Click Uno's face in the sidebar", "Uno's page", async () => {
    await home(page);
    await page
      .getByTestId("sidebar-assistant")
      .first()
      .getByTestId("sidebar-assistant-face")
      .click();
    await page.waitForTimeout(1500);
    await snap(page, "d09-uno-face", true);
    return { heading: await headingText(page) };
  });

  await run(
    page,
    "d10-back",
    "Press ← on Uno's page",
    "Back where I came from / to my assistants",
    async () => {
      await page
        .locator("header button")
        .filter({ hasText: /Assistants|Back/ })
        .first()
        .click();
      await page.waitForTimeout(1200);
      await snap(page, "d10-back");
      return { heading: await headingText(page) };
    },
  );

  // ── Create ────────────────────────────────────────────────────────────
  await run(page, "d11-gallery", "+ next to Assistants", "Pick what kind of helper", async () => {
    await home(page);
    await page.getByTestId("sidebar-new-assistant").click();
    await page.getByTestId("persona-gallery").waitFor();
    await snap(page, "d11-gallery");
  });
  await run(page, "d12-who", "Developer → name it Rex", "Name and face", async () => {
    await page.getByTestId("persona-card-developer").click();
    await page.getByTestId("persona-name").waitFor();
    await page.getByTestId("persona-name").fill("Rex");
    await snap(page, "d12-who", true);
  });
  await run(
    page,
    "d13-where",
    "Next → where it works",
    "Computer, AI, projects, mode",
    async () => {
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-works-on").waitFor();
      await snap(page, "d13-where", true);
    },
  );
  await run(page, "d14-job", "Next → what it does", "Its job", async () => {
    await page.getByTestId("persona-next").click();
    await page.getByTestId("persona-create").waitFor();
    await snap(page, "d14-job", true);
  });
  await run(
    page,
    "d15-channel",
    "Create → where I talk to it (Telegram)",
    "Telegram in one click",
    async () => {
      await page.getByTestId("persona-create").click();
      await page.getByTestId("persona-channel").waitFor({ timeout: 15_000 });
      await snap(page, "d15-channel", true);
    },
  );
  await run(page, "d16-rex-chat", "Open its chat", "Rex's chat", async () => {
    await page.getByTestId("persona-open").click();
    await page.waitForTimeout(2500);
    await snap(page, "d16-rex-chat");
    return { header: await headerButtons(page) };
  });

  // ── Go back and change it (the main pain) ───────────────────────────────
  await run(
    page,
    "d17-rex-settings",
    "Change Rex's settings: find the way from its chat",
    "Settings button with a label",
    async () => {
      const explicit = page.getByTestId("assistant-header-settings");
      if ((await explicit.count()) > 0) await explicit.first().click();
      else await page.getByTestId("teammate-headline").click();
      await page.getByTestId("assistant-profile").waitFor();
      await snap(page, "d17-rex-settings", true);
      return { explicitButton: (await explicit.count()) > 0 };
    },
  );
  await run(
    page,
    "d18-rename",
    "Rename Rex → Rex Ops",
    "Pencil next to the name, save",
    async () => {
      await page.getByTestId("assistant-profile-who-edit").click();
      await page.waitForTimeout(500);
      const input = page.locator('[data-testid="assistant-profile"] input').first();
      await input.fill("Rex Ops");
      await snap(page, "d18-rename");
      await page.getByRole("button", { name: /^Save/ }).first().click();
      await page.waitForTimeout(1200);
      await snap(page, "d18b-renamed");
      return { sidebar: await sidebarNames(page) };
    },
  );
  await run(
    page,
    "d19-mode",
    "Switch Autonomous → Cautious",
    "Two big options, one click",
    async () => {
      await page.getByTestId("assistant-mode-switch-asks-first").click();
      await page.waitForTimeout(1200);
      await snap(page, "d19-mode");
    },
  );
  await run(
    page,
    "d20-advanced",
    "Where are computer / apps / AI / instructions?",
    "Each on its own tab, no long scroll",
    async () => {
      const tabs = page.getByTestId("assistant-profile-tabs");
      if ((await tabs.count()) > 0) {
        await snap(page, "d20a-tab-general");
        await page.getByTestId("assistant-profile-tab-where").click();
        await page.waitForTimeout(800);
        await snap(page, "d20-advanced");
        await page.getByTestId("assistant-profile-tab-apps").click();
        await page.waitForTimeout(800);
        await snap(page, "d20b-tab-apps");
        return { tabs: true };
      }
      const toggle = page.getByTestId("assistant-advanced-toggle");
      const hidden = (await toggle.count()) > 0;
      if (hidden) await toggle.click();
      await page.waitForTimeout(800);
      await snap(page, "d20-advanced", true);
      return { behindAdvanced: hidden };
    },
  );
  await run(
    page,
    "d21-instructions",
    "Edit its instructions",
    "Its instructions open right here",
    async () => {
      const tab = page.getByTestId("assistant-profile-tab-memory");
      if ((await tab.count()) > 0) await tab.click();
      else await page.getByTestId("assistant-profile-memory-edit").click();
      await page.waitForTimeout(1500);
      await snap(page, "d21-instructions");
      return { heading: await headingText(page) };
    },
  );
  await run(page, "d22-back-from-instructions", "Press ← there", "Back on Rex's page", async () => {
    await page
      .locator("header button")
      .filter({ hasText: /Assistants|Back|Rex/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await snap(page, "d22-back-from-instructions");
    return { heading: await headingText(page) };
  });

  // ── Work with Uno ───────────────────────────────────────────────────────
  await run(
    page,
    "d23-task",
    "Give Uno a task: “morning summary”",
    "An answer with results",
    async () => {
      await home(page);
      await page
        .getByTestId("sidebar-assistant")
        .first()
        .getByTestId("sidebar-assistant-open")
        .click();
      await page.waitForTimeout(1200);
      const box = page.locator('[contenteditable="true"]').last();
      await box.click();
      await box.fill("Give me the morning summary");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(9000);
      await snap(page, "d23-task");
    },
  );
  await run(
    page,
    "d24-automations",
    "Automations of an assistant",
    "On its page, add one",
    async () => {
      await home(page);
      await row(page, "assistant-mia").getByTestId("sidebar-assistant-face").click();
      await page.getByTestId("assistant-profile").waitFor();
      const tasksTab = page.getByTestId("assistant-profile-tab-tasks");
    if ((await tasksTab.count()) > 0) await tasksTab.click();
    const section = page.getByText(/Automations/).first();
      await section.scrollIntoViewIfNeeded();
      await snap(page, "d24-automations");
    },
  );
  await run(page, "d25-remove", "Remove Rex", "A plain Remove with a confirm", async () => {
    await home(page);
    const rex = page.getByTestId("sidebar-assistant").filter({ hasText: /Rex/ }).first();
    await rex.getByTestId("sidebar-assistant-face").click();
    await page.getByTestId("assistant-profile").waitFor();
    await page.getByTestId("assistant-profile-remove").scrollIntoViewIfNeeded();
    await page.getByTestId("assistant-profile-remove").click();
    await snap(page, "d25-remove");
    await page.getByTestId("assistant-profile-remove-confirm").click();
    await page.waitForTimeout(1500);
    await snap(page, "d25b-removed");
    return { sidebar: await sidebarNames(page) };
  });
  await run(
    page,
    "d26-row-gear",
    "Sidebar: hover Mia's row — a way to its settings?",
    "A gear on the row",
    async () => {
      await home(page);
      const mia = row(page, "assistant-mia");
      await mia.hover();
      await page.waitForTimeout(500);
      const gear = mia.getByTestId("sidebar-assistant-settings");
      const has = (await gear.count()) > 0;
      if (has) {
        await gear.hover();
        await page.waitForTimeout(500);
      }
      await snap(page, "d26-row-gear");
      if (has) {
        await gear.click();
        await page.getByTestId("assistant-profile").waitFor();
      }
      return { gearOnRow: has };
    },
  );
  await context.close();
}

async function asks() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await run(
    page,
    "a01-ask",
    "Cautious Uno: “send the Acme invoice reminder”",
    "It asks before sending: Allow / Decline",
    async () => {
      await openDemo(page, server.url, { mode: "asks-first" });
      await page
        .getByTestId("sidebar-assistant")
        .first()
        .getByTestId("sidebar-assistant-open")
        .click();
      await page.waitForTimeout(1200);
      const box = page.locator('[contenteditable="true"]').last();
      await box.click();
      await box.fill("Send Acme the invoice reminder");
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: /^(Allow|Approve)/ })
        .first()
        .waitFor({ timeout: 30_000 });
      await snap(page, "a01-ask");
    },
  );
  await run(page, "a02-allow", "Allow", "It sends and says so", async () => {
    await page
      .getByRole("button", { name: /^(Allow|Approve)/ })
      .first()
      .click();
    await page.waitForTimeout(5000);
    await snap(page, "a02-allow");
  });
  await context.close();
}

async function mobile() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await run(page, "m01-open", "Phone: open the app", "Chat with a menu button", async () => {
    await openDemo(page, server.url);
    await dismissBanners(page);
    await snap(page, "m01-open");
  });
  await run(
    page,
    "m02-sidebar",
    "Phone: open the menu",
    "Assistants block with settings",
    async () => {
      await page
        .locator(
          '[data-sidebar="trigger"], [aria-label="Toggle Sidebar"], [aria-label="Show sidebar"]',
        )
        .first()
        .click();
      await page.waitForTimeout(800);
      await snap(page, "m02-sidebar");
    },
  );
  await run(
    page,
    "m03-mia-chat",
    "Phone: open Mia's chat",
    "Header fits, settings reachable",
    async () => {
      await row(page, "assistant-mia").getByTestId("sidebar-assistant-open").click();
      await page.waitForTimeout(1500);
      await snap(page, "m03-mia-chat");
      return { header: await headerButtons(page) };
    },
  );
  await run(
    page,
    "m04-mia-settings",
    "Phone: Mia's settings",
    "Opens and reads well on a phone",
    async () => {
      const explicit = page.getByTestId("assistant-header-settings");
      if ((await explicit.count()) > 0) await explicit.first().click();
      else await page.getByTestId("teammate-headline").click();
      await page.getByTestId("assistant-profile").waitFor();
      await snap(page, "m04-mia-settings");
    },
  );
  await run(
    page,
    "m05-uno-chat",
    "Phone: Uno's chat header",
    "Fits on one line, buttons make sense",
    async () => {
      await page
        .locator(
          '[data-sidebar="trigger"], [aria-label="Toggle Sidebar"], [aria-label="Show sidebar"]',
        )
        .first()
        .click();
      await page.waitForTimeout(600);
      await page
        .getByTestId("sidebar-assistant")
        .first()
        .getByTestId("sidebar-assistant-open")
        .click();
      await page.waitForTimeout(1500);
      await snap(page, "m05-uno-chat");
      return { header: await headerButtons(page) };
    },
  );
  await run(
    page,
    "m06-uno-settings",
    "Phone: Uno's settings from its chat",
    "One tap on a gear",
    async () => {
      const explicit = page.getByTestId("assistant-header-settings");
      if ((await explicit.count()) === 0) throw new Error("no Settings button in Uno's header");
      await explicit.first().click();
      await page.getByTestId("assistant-profile").waitFor();
      await snap(page, "m06-uno-settings");
    },
  );
  await context.close();
}

if (only === "all" || only === "desktop") await desktop();
if (only === "all" || only === "asks") await asks();
if (only === "all" || only === "mobile") await mobile();
writeFileSync(join(OUT, "walk.json"), JSON.stringify(log, null, 2));
await browser.close();
server.close();
