// Runs the demo flows: `node demo-e2e/run.mjs` (all) or `node demo-e2e/run.mjs base-new`.
// Each flow gets a fresh browser context (fresh storage = fresh world).
// Screenshots go to demo-e2e/shots/<flow>-<n>.png; the summary to stdout and
// demo-e2e/shots/report.json (status, failed step, console errors).
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SHOTS, launch, serve, shot } from "./harness.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(join(here, "flows")).filter((file) => file.endsWith(".flow.mjs"));
const flows = [];
for (const file of files) {
  const module = await import(pathToFileURL(join(here, "flows", file)).href);
  for (const item of [module.default, ...(module.flows ?? [])].filter(Boolean)) {
    if (only.length === 0 || only.some((name) => item.name.includes(name))) flows.push(item);
  }
}

// DEMO_URL=https://… DEMO_PASSWORD=… runs the flows against the published site.
const server = process.env.DEMO_URL
  ? { url: process.env.DEMO_URL.replace(/\/?$/, "/"), close: () => undefined }
  : await serve();
const browser = await launch();
const report = [];
for (const item of flows) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (process.env.DEMO_URL && process.env.DEMO_PASSWORD) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const input = page.locator('input[name="password"]');
        if (await input.isVisible().catch(() => false)) {
          await input.fill(process.env.DEMO_PASSWORD);
          await input.press("Enter");
          // The unlock page posts and redirects: wait until the form is gone.
          await input.waitFor({ state: "detached", timeout: 60_000 });
        }
        break;
      } catch {
        // the site is a 10 MB SPA behind a CDN: try again
      }
    }
  }
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 300)));
  let current = "start";
  let shots = 0;
  const started = Date.now();
  try {
    await item.body({
      page,
      url: server.url,
      step: async (title, fn) => {
        current = title;
        await fn();
      },
      shot: (label) => shot(page, `${item.name}-${String(++shots).padStart(2, "0")}-${label}`),
    });
    report.push({ flow: item.name, ok: true, ms: Date.now() - started, errors });
    console.log(`✓ ${item.name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    await shot(page, `${item.name}-FAILED`).catch(() => undefined);
    report.push({
      flow: item.name,
      ok: false,
      step: current,
      error: String(error).slice(0, 500),
      errors,
    });
    console.log(`✗ ${item.name} — at “${current}”: ${String(error).split("\n")[0]}`);
  }
  await context.close();
}
await browser.close();
server.close();
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SHOTS, "report.json"), JSON.stringify(report, null, 2));
const failed = report.filter((item) => !item.ok).length;
console.log(`${report.length - failed}/${report.length} flows passed · shots in ${SHOTS}`);
process.exit(failed > 0 ? 1 : 0);
