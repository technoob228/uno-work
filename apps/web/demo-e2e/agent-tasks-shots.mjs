// Agent tasks inside the coordinator (Misha 13.11), on the assist demo's live
// world (demo/assist/fixtures.ts): "Pricing page: copy, checkout, launch"
// (w-launch) started four tasks — the copy (working), the launch check (done),
// the checkout (called the person: Needs you) and the OG image (failed).
// Works on an older build too (the "before" shots): a missing part is logged.
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
async function setOnlyMine(on) {
  await page.locator("[data-testid=sidebar-d-view-trigger]").click({ timeout: 5000 });
  const item = page.locator("[data-testid=sidebar-d-only-mine]");
  const checked = (await item.getAttribute("aria-checked")) === "true";
  if (checked !== on) await item.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
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

// 1. The sidebar as it opens (Only mine on): the tasks stay out; the one that
// called the person is there, "Needs you".
console.log("sidebar:\n  " + (await rows()).join("\n  "));
await shot("01-sidebar-default", await sidebarBox());

// 2. Only mine off: still no tasks — they are not the person's list.
await step("only-mine-off", async () => {
  await setOnlyMine(false);
  console.log("only mine off:\n  " + (await rows()).join("\n  "));
  await shot("02-sidebar-all-chats", await sidebarBox());
});

// 3. The coordinator: the Tasks strip above the composer, the tasks' reports
// folded in the feed.
await step("coordinator", async () => {
  await openChat("Pricing page");
  const strip = await page
    .locator("[data-testid=agent-tasks-bar]")
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  console.log("tasks strip:", strip);
  const reports = await page
    .locator("[data-testid=agent-task-report]")
    .allTextContents()
    .catch(() => []);
  console.log("folded reports:", reports);
  await page.mouse.move(1270, 10);
  await shot("03-coordinator");
});

// 4. A report unfolded.
await step("report-open", async () => {
  await page.locator("[data-testid=agent-task-report-toggle]").last().click({ timeout: 3000 });
  await page.waitForTimeout(800);
  await shot("04-report-unfolded");
});

// 5. "Move to sidebar" on the launch check: it is pinned on top.
await step("move-up", async () => {
  await page
    .locator("[data-testid=agent-task-row]", { hasText: "Launch check" })
    .locator("[data-testid=agent-task-move]")
    .click({ timeout: 3000 });
  await page.waitForTimeout(1200);
  console.log("after move:\n  " + (await rows()).join("\n  "));
  await shot("05-moved-to-sidebar", await sidebarBox());
});

// 6. Archive the coordinator: asked first (the copy still works), then its
// tasks go with it.
await step("archive", async () => {
  const row = page.locator("[data-testid=sidebar-row-d]", { hasText: "Pricing page" }).first();
  await row.click({ button: "right", timeout: 5000 });
  await page.getByRole("button", { name: "Archive", exact: true }).last().click({ timeout: 3000 });
  await page.waitForTimeout(1500);
  console.log("confirm:", dialogs.at(-1) ?? "(none)");
  console.log("after archive:\n  " + (await rows()).join("\n  "));
  await shot("06-after-archive", await sidebarBox());
});

await browser.close();
