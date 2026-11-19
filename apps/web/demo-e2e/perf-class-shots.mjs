// Machine class (19.11): Performance / Standard when a cloud computer is made,
// the class_notice toast, the two refusals and the "Performance" badge. The
// demo's account answers `GET /api/v1/account/machine-class` and the launch
// per world (`perf=max|plus|busy|full`, src/demo/assist/world.ts), so this walks
// the production components. Light theme, 1440 wide, ×2.
//   demo-e2e/build-demo.sh && node demo-e2e/perf-class-shots.mjs [shots-dir]
import { mkdirSync } from "node:fs";

import { dismissBanners, launch, openDemo, serve } from "./harness.mjs";

const out = process.argv[2] ?? null;
if (out) mkdirSync(out, { recursive: true });
const server = await serve();
const browser = await launch();
const fails = [];
const pageErrors = [];

async function newPage(world) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 200)));
  await openDemo(page, server.url, { lc: "connected", ...world });
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  return page;
}

let page;
const shot = async (name, target = page) => {
  if (out) await target.screenshot({ path: `${out}/${name}.png` });
};
const expect = (what, got, want) => {
  const ok = String(got).includes(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${String(got).replace(/\s+/g, " ").slice(0, 140)}`);
  if (!ok) fails.push(what);
};
const id = (testId) => page.getByTestId(testId).first();
async function step(name, body) {
  try {
    await body();
  } catch (error) {
    console.log(`FAIL ${name}: ${String(error).split("\n")[0]}`);
    fails.push(name);
    if (out) {
      const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      await page.screenshot({ path: `${out}/FAIL-${slug}.png` }).catch(() => undefined);
    }
  }
}

/** Home → Connect your AI or other computers → Add computer → Uno cloud computer → Create. */
async function openCreate() {
  await page.evaluate(() => {
    location.hash = "#/computer";
  });
  await page.waitForTimeout(1500);
  await dismissBanners(page);
  await id("home-connect-choice").click();
  await id("connect-choice-computer").click();
  await id("lc-add-cloud").click();
  await page.getByRole("button", { name: "Create a new computer" }).click();
  await id("machine-class-picker").waitFor({ timeout: 10_000 });
  await page.locator("#uno-box-name").fill("research");
  await page.waitForTimeout(600);
}

const dialog = () => page.getByRole("dialog").last();
const create = () => dialog().getByRole("button", { name: "Create computer" }).click();
const checked = async (option) => id(`machine-class-${option}`).getAttribute("aria-checked");

// ── Max: Performance preselected ─────────────────────────────────────────
await step("max: Performance preselected", async () => {
  page = await newPage({ perf: "max" });
  await openCreate();
  expect("Performance is chosen", await checked("performance"), "true");
  expect("Standard is not", await checked("standard"), "false");
  await shot("01-max-create-performance-preselected", dialog());
});

await step("max: Performance badge on uno-work", async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    location.hash = "#/my-uno";
  });
  await page.waitForTimeout(2500);
  await dismissBanners(page);
  const badge = id("performance-badge");
  await badge.waitFor({ timeout: 10_000 });
  expect("Badge says Performance", await badge.innerText(), "Performance");
  await shot("05-badge-my-uno-computers");
  await id("my-uno-computer").click();
  await page.waitForTimeout(1200);
  await shot("06-badge-my-uno-computer-detail");
});

// ── Plus: Performance comes with Max ─────────────────────────────────────
await step("plus: Performance disabled", async () => {
  page = await newPage({ perf: "plus" });
  await openCreate();
  expect("Standard is chosen", await checked("standard"), "true");
  expect(
    "Performance is locked",
    await id("machine-class-performance").innerText(),
    "Comes with Max",
  );
  expect("…with See Max", await id("machine-class-see-max").innerText(), "See Max");
  await shot("02-plus-create-performance-disabled", dialog());
});

// ── Busy: made Standard, class_notice ────────────────────────────────────
await step("busy: class_notice after create", async () => {
  page = await newPage({ perf: "busy" });
  await openCreate();
  await create();
  const toast = page.getByText("Performance servers were busy, so this computer is Standard.");
  await toast.first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot("03-class-notice-after-create");
});

// ── Full: 503 PERFORMANCE_NO_CAPACITY ────────────────────────────────────
await step("full: no Performance capacity", async () => {
  page = await newPage({ perf: "full" });
  await openCreate();
  await create();
  const notice = id("machine-error-notice");
  await notice.waitFor({ timeout: 15_000 });
  expect(
    "No-capacity message",
    await notice.innerText(),
    "All Performance servers are busy. Try again in a few minutes, or create a Standard computer.",
  );
  await page.waitForTimeout(400);
  await shot("04a-error-performance-no-capacity", dialog());
  await id("machine-class-use-standard").click();
  await page.waitForTimeout(300);
  expect("Use Standard picks Standard", await checked("standard"), "true");
});

// ── Performance picked, the plan went down before Create: 403 ──────────
await step("lapsed: 403 PERFORMANCE_REQUIRES_MAX", async () => {
  page = await newPage({ perf: "lapsed" });
  await openCreate();
  expect("Standard is the account's pick", await checked("standard"), "true");
  await id("machine-class-performance").click();
  await create();
  const notice = id("machine-error-notice");
  await notice.waitFor({ timeout: 15_000 });
  expect(
    "Requires-Max message",
    await notice.innerText(),
    "Performance computers come with the Max plan. Create a Standard one or switch to Max.",
  );
  await page.waitForTimeout(400);
  await shot("04b-error-performance-requires-max", dialog());
});

console.log(pageErrors.length ? `page errors:\n  ${pageErrors.join("\n  ")}` : "no page errors");
console.log(fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all ok");
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);
