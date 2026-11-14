// Who handles a chat (Misha 13.11, v2), on the assist demo's live world
// (demo/assist/fixtures.ts): "Pricing page: copy, checkout, launch" (w-launch)
// runs two threads (the copy: working, the checkout: called the person) and
// three subagents (launch check: done, OG image: failed, Codex review: done);
// "Weekly SEO report for the landing" is the person's chat handed to its agent.
// Agent-handled chats sit under a folded "Agents' chats" shelf in the sidebar;
// Join brings one into the list, "Hand to agent" sends it back.
// Works on an older build too: a missing part is logged and skipped.
// Usage, on a built demo (demo-e2e/build-demo.sh):
//   python3 -m http.server 5791 -d dist-demo &
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright \
//     node demo-e2e/agent-tasks-shots.mjs <out-dir> [base-url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "demo-e2e/shots/agent-tasks";
const base = process.argv[3] ?? "http://localhost:5791";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (error) => console.log("pageerror:", error.message));
const dialogs = [];
page.on("dialog", (dialog) => {
  dialogs.push(dialog.message());
  void dialog.accept();
});

async function shot(name, clip) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(file);
}
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    console.log(`step ${name} skipped:`, String(error?.message ?? error).split("\n")[0]);
  }
}
async function dismissCards() {
  for (const name of ["Not now", "Got it", "Skip"]) {
    await page
      .getByRole("button", { name })
      .first()
      .click({ timeout: 1200 })
      .catch(() => {});
  }
}
async function sidebarBox() {
  const box = await page.locator("[data-sidebar=sidebar]").first().boundingBox();
  return box ?? { x: 0, y: 0, width: 320, height: 860 };
}
async function rows() {
  return page
    .locator("[data-testid=sidebar-row-d]")
    .evaluateAll((els) =>
      els.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)),
    );
}
async function viewMenu(run) {
  await page.locator("[data-testid=sidebar-d-view-trigger]").click({ timeout: 5000 });
  await page.waitForTimeout(400);
  await run();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}
async function setMenuCheck(testid, on) {
  const item = page.locator(`[data-testid=${testid}]`);
  const checked = (await item.getAttribute("aria-checked")) === "true";
  if (checked !== on) await item.click();
}
async function wide() {
  const box = await sidebarBox();
  return { x: 0, y: 0, width: box.width + 360, height: 860 };
}

async function openChat(text) {
  await page
    .locator("[data-testid=sidebar-row-d]", { hasText: text })
    .first()
    .click({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await dismissCards();
}

await page.goto(`${base}/?demo=assist`, { waitUntil: "commit", timeout: 180_000 });
await page.waitForSelector("[data-testid=sidebar-row-d]", { timeout: 180_000 });
await page.waitForTimeout(2500);
await dismissCards();

// 1. The sidebar as it opens: agent-handled chats are out of the list, under a
// folded "Agents' chats" line; the checkout called the person, so it is there.
console.log("sidebar:\n  " + (await rows()).join("\n  "));
await shot("01-sidebar-default", await sidebarBox());

// 2. The shelf unfolded: Threads and Subagents apart.
await step("shelf-open", async () => {
  await page.locator("[data-testid=sidebar-agents-shelf-toggle]").click({ timeout: 5000 });
  await page.waitForTimeout(800);
  for (const group of ["threads", "subagents"]) {
    const text = await page
      .locator(`[data-testid=sidebar-agents-${group}]`)
      .textContent({ timeout: 2000 })
      .catch(() => null);
    console.log(`shelf ${group}:`, text?.replace(/\s+/g, " ").trim());
  }
  await shot("02-agents-shelf-open", await sidebarBox());
});

// 3. The view menu: show agents' threads / subagents right in the list.
await step("view-menu", async () => {
  await page.locator("[data-testid=sidebar-d-view-trigger]").click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await page.locator("[data-testid=sidebar-d-inline-agent-threads]").waitFor({ timeout: 3000 });
  await shot("03-view-menu", await wide());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
});

// 4. Agents' threads inline: they come into the list, subagents stay on the shelf.
await step("inline-threads", async () => {
  await viewMenu(() => setMenuCheck("sidebar-d-inline-agent-threads", true));
  const hidden = await page
    .getByText(/agent chats? hidden/)
    .textContent({ timeout: 500 })
    .catch(() => null);
  console.log("hidden line:", hidden);
  console.log("threads inline:\n  " + (await rows()).join("\n  "));
  await shot("04-threads-inline", await sidebarBox());
  await viewMenu(() => setMenuCheck("sidebar-d-inline-agent-threads", false));
});

// 5. The coordinator: the Tasks strip, threads and subagents grouped, Join /
// Hand to agent on each.
await step("coordinator", async () => {
  // Only mine counts the coordinator as the agent's (its agent wrote last, a
  // rule of the sidebar branch): "Show" on the hidden line brings it back.
  const coordinator = page.locator("[data-testid=sidebar-row-d]", {
    hasText: "Pricing page: copy",
  });
  if ((await coordinator.count()) === 0) {
    await page
      .getByText(/agent chats? hidden/)
      .locator("..")
      .getByText("Show")
      .click({ timeout: 3000 });
    await page.waitForTimeout(600);
  }
  await openChat("Pricing page: copy");
  const bar = page.locator("[data-testid=agent-tasks-bar]").first();
  if ((await bar.getAttribute("data-expanded", { timeout: 3000 })) !== "true") {
    await page.locator("[data-testid=agent-tasks-toggle]").first().click({ timeout: 3000 });
    await page.waitForTimeout(600);
  }
  console.log("tasks strip:", (await bar.textContent())?.replace(/\s+/g, " ").trim());
  await page.mouse.move(1270, 10);
  await shot("05-coordinator-tasks");
});

// 6. Join the copy thread from the strip: it moves into the sidebar list.
await step("join", async () => {
  await page
    .locator("[data-testid=agent-task-row]", { hasText: "Pricing page copy" })
    .locator("[data-testid=agent-task-handoff]")
    .click({ timeout: 3000 });
  await page.waitForTimeout(1200);
  console.log("after join:\n  " + (await rows()).join("\n  "));
  await page.mouse.move(1270, 10);
  await shot("06-joined");
});

// 7. The person's chat handed to its agent: the bar says so, Join takes it back.
await step("handed-off", async () => {
  await openChat("Weekly SEO report");
  const bar = await page
    .locator("[data-testid=thread-control-bar]")
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  console.log("control bar:", bar?.replace(/\s+/g, " ").trim());
  await page.mouse.move(1270, 10);
  await shot("07-handed-off-chat");
});

await browser.close();
