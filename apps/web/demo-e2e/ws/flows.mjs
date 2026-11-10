// Workspace vision (10.11): the main and edge flows on the demo build of the
// real Work web client. `node demo-e2e/ws/flows.mjs [name…]` →
// demo-e2e/shots/ws/<flow>-<step>.png + demo-e2e/shots/ws/report.json.
// Build first: demo-e2e/build-demo.sh.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  dismissBanners,
  launch,
  openDemo,
  openMainChat,
  scene,
  seeText,
  serve,
  SHOTS,
} from "../harness.mjs";

const OUT = join(SHOTS, "ws");
mkdirSync(OUT, { recursive: true });

async function go(page, hash) {
  await page.evaluate((h) => (location.hash = h), hash);
}

// The demo's hash history drops a search typed into the address (My Uno's too):
// flows get around by clicking, as a person does.
async function workspace(page, tab = "apps") {
  await page.getByTestId(tab === "hardware" ? "sidebar-nav-hardware" : "sidebar-nav-apps").click();
  await page
    .getByTestId(tab === "hardware" ? "ws-hardware" : "ws-apps")
    .waitFor({ timeout: 15_000 });
}

async function openApp(page, id, name) {
  await workspace(page);
  await page.getByTestId(`ws-app-${id}`).getByRole("button", { name, exact: true }).click();
  await page.getByTestId("ws-app-panel").waitFor({ timeout: 10_000 });
}

async function assistantWhere(page) {
  await page
    .locator('[data-testid="sidebar-assistant"][data-assistant="assistant-home"]')
    .getByTestId("sidebar-assistant-face")
    .click();
  await page.getByTestId("assistant-profile-tab-where").click();
  await page.getByTestId("ws-assistant-hands").waitFor({ timeout: 15_000 });
}

const flows = [
  {
    name: "home",
    world: {},
    async run({ page, shot, step }) {
      await step("home shows the workspace pill and Hardware in the sidebar", async () => {
        await page.getByTestId("ws-pill").waitFor({ timeout: 15_000 });
        await page.getByTestId("sidebar-nav-hardware").waitFor();
      });
      await shot("home");
      await step("the pill opens the hardware", async () => {
        await page.getByTestId("ws-pill").click();
        await page.getByTestId("ws-hardware").waitFor();
      });
      await shot("hardware");
    },
  },
  {
    name: "app-asleep",
    world: {},
    async run({ page, shot, step }) {
      await step("apps of the workspace", () => workspace(page));
      await shot("apps");
      await step("Stats board: free-cloud is asleep, opening wakes it", async () => {
        await page.getByTestId("ws-app-stats").getByRole("button", { name: "Stats board" }).click();
        await page.getByTestId("ws-app-panel").waitFor();
        await seeText(page, "free-cloud is asleep. Opening wakes it");
      });
      await shot("card-asleep");
      let popup;
      await step("Wake & open → waking → the app opens in its own tab", async () => {
        const waitPopup = page.context().waitForEvent("page", { timeout: 15_000 });
        await page.getByTestId("ws-app-panel").getByTestId("ws-app-open").click();
        await seeText(page, "Waking free-cloud", 5_000);
        await shot("waking");
        popup = await waitPopup;
        await popup.waitForLoadState();
        await popup.getByText("Stats board").first().waitFor();
      });
      if (popup) {
        await popup.setViewportSize({ width: 1100, height: 640 });
        await popup.screenshot({ path: join(OUT, "app-asleep-opened.png") });
        await popup.close();
      }
      await step("after it: free-cloud is on, the card says it opens from anywhere", async () => {
        await seeText(page, "Opens from any computer.", 10_000);
        await page.locator('[data-testid="ws-strip-free-cloud"][data-state="running"]').waitFor();
      });
      await shot("card-after");
    },
  },
  {
    name: "app-uses",
    world: {},
    async run({ page, shot, step }) {
      await step("Orders dashboard's card lists everything it uses", async () => {
        await openApp(page, "orders", "Orders dashboard");
        for (const ref of ["uno-work", "fn-orders-hook", "db-orders", "drive", "dom-orders"])
          await page.getByTestId(`ws-use-${ref}`).waitFor();
      });
      await shot("orders");
      await step("Landing uses no computer at all", async () => {
        await page.getByTestId("ws-app-landing").getByRole("button", { name: "Landing" }).click();
        await page.getByTestId("ws-use-fn-signup").waitFor();
        await seeText(page, "Opens from any computer.");
      });
      await shot("landing");
    },
  },
  {
    name: "mac-away",
    world: { mac: "offline" },
    async run({ page, shot, step }) {
      await step("Deck preview runs on the MacBook, which is offline: said plainly", async () => {
        await openApp(page, "deck", "Deck preview");
        await seeText(page, "Runs on your MacBook, which is offline");
        await page.getByTestId("ws-app-panel").getByTestId("ws-app-away").waitFor();
      });
      await shot("deck");
      await step("Move it to uno-work", async () => {
        await page.getByTestId("ws-app-move").click();
        await seeText(page, "Moving Deck preview to uno-work");
      });
      await shot("move");
      await step("the chat chip won't send a turn to the offline Mac", async () => {
        await openMainChat(page, "work");
        await page.getByTestId("ws-runs-on").click();
        const mac = page.getByTestId("ws-runs-on-macbook");
        await mac.waitFor();
        if (
          (await mac.getAttribute("data-disabled")) === null &&
          (await mac.getAttribute("aria-disabled")) !== "true"
        )
          throw new Error("offline MacBook is pickable");
      });
      await shot("chip-mac-offline");
    },
  },
  {
    name: "hardware",
    world: {},
    async run({ page, shot, step }) {
      await step("every part with its state and who uses it", async () => {
        await workspace(page, "hardware");
        await page.getByTestId("ws-part-db-orders").waitFor();
        await seeText(page, "on uno-work");
      });
      await shot("all");
      await step("MacBook's card: apps, assistants, its own terminal", async () => {
        await page
          .getByTestId("ws-computer-macbook")
          .getByRole("button", { name: "MacBook" })
          .click();
        await page.getByTestId("ws-computer-panel").waitFor();
        await seeText(page, "Its terminal and files stay on MacBook");
      });
      await shot("macbook");
      await step("wake free-cloud from its row", async () => {
        await page.getByTestId("ws-wake-free-cloud").click();
        await page
          .locator('[data-testid="ws-strip-free-cloud"][data-state="running"]')
          .waitFor({ timeout: 10_000 });
      });
      await shot("woken");
    },
  },
  {
    name: "join",
    world: {},
    async run({ page, shot, step }) {
      await step("a Raspberry Pi joins: one question", async () => {
        await workspace(page, "hardware");
        await page.evaluate(() => window.__wsDemo.join());
        await page.getByTestId("ws-new-computer").waitFor({ timeout: 10_000 });
      });
      await shot("asked");
      await step("Let Uno use it → it's in Uno's hands", async () => {
        await page.getByTestId("ws-new-allow").click();
        await page.getByTestId("ws-new-computer").waitFor({ state: "detached", timeout: 10_000 });
        await assistantWhere(page);
        const pi = page.getByTestId("ws-hand-raspberry-pi").getByRole("switch");
        if ((await pi.getAttribute("aria-checked")) !== "true")
          throw new Error("Pi not in Uno's hands");
      });
      await shot("uno-hands");
    },
  },
  {
    name: "assistant",
    world: {},
    async run({ page, shot, step }) {
      await step("Uno's page: lives in the workspace, several computers as hands", async () => {
        await assistantWhere(page);
        await seeText(page, "Lives in your workspace");
      });
      await shot("hands");
      await step("give it free-cloud: asleep, it wakes it when needed", async () => {
        await page.getByTestId("ws-hand-free-cloud").getByRole("switch").click();
        await seeText(page, "Asleep · wakes it when needed");
      });
      await shot("hands-free-cloud");
      await step("its chat says where it lives", async () => {
        await openMainChat(page, "work");
        await seeText(page, "Lives in your workspace");
      });
      await shot("chat");
    },
  },
  {
    name: "tg-asleep",
    world: { tg: "on" },
    async run({ page, shot, step }) {
      await step("every computer asleep: Uno answers Telegram from the workspace", async () => {
        await openMainChat(page, "work");
        await scene(page, "ws-tg-asleep");
        await seeText(page, "I answered from your workspace", 30_000);
      });
      await shot("answered");
      await step("a build needs hands: it wakes uno-work", async () => {
        await seeText(page, "Waking uno-work", 20_000);
      });
      await shot("waking");
      await step("…and does it", async () => {
        await seeText(page, "Done: landing-misha.uno4.me", 40_000);
      });
      await shot("done");
      await step("uno-work is on again in the hardware", async () => {
        await workspace(page, "hardware");
        await page
          .locator('[data-testid="ws-strip-uno-work"][data-state="running"]')
          .waitFor({ timeout: 10_000 });
      });
      await shot("hardware");
    },
  },
  {
    name: "chat-chip",
    world: {},
    async run({ page, shot, step }) {
      await step("a chat says where its next turn runs", async () => {
        await openMainChat(page, "work");
        await page.getByTestId("ws-runs-on").waitFor({ timeout: 15_000 });
        await seeText(page, "Runs on uno-work");
      });
      await shot("chip");
      await step("the menu: every computer with its state", async () => {
        await page.getByTestId("ws-runs-on").click();
        await page.getByTestId("ws-runs-on-free-cloud").waitFor();
      });
      await shot("menu");
      await step("next message on free-cloud: it wakes on send", async () => {
        await page.getByTestId("ws-runs-on-free-cloud").click();
        await seeText(page, "wakes when you send");
      });
      await shot("free-cloud");
    },
  },
  {
    name: "terminal",
    world: {},
    async run({ page, shot, step }) {
      await step("hardware → uno-work → Terminal: a shell on that computer", async () => {
        await workspace(page, "hardware");
        await page.getByTestId("ws-terminal-uno-work").click();
        await seeText(page, "Terminal on uno-work", 20_000);
      });
      await step("hostname answers uno-work", async () => {
        const term = page.locator(".xterm-helper-textarea").last();
        await term.focus();
        await page.keyboard.type("hostname");
        await page.keyboard.press("Enter");
        await page
          .locator(".xterm-rows")
          .last()
          .getByText("uno-work")
          .nth(1)
          .waitFor({ timeout: 10_000 });
      });
      await shot("uno-work");
      await step("the MacBook's terminal is the MacBook's", async () => {
        await workspace(page, "hardware");
        await page.getByTestId("ws-terminal-macbook").click();
        await seeText(page, "Terminal on your MacBook", 20_000);
      });
      await shot("macbook");
    },
  },
  {
    name: "today",
    world: { ws: "off" },
    async run({ page, shot, step }) {
      await step("ws=off: today's Work, for comparison", async () => {
        await page.getByTestId("sidebar-nav-apps").waitFor();
        if (await page.getByTestId("ws-pill").count())
          throw new Error("workspace pill in today's Work");
      });
      await shot("home");
      await step("today's chat header", async () => {
        await openMainChat(page, "work");
      });
      await shot("chat");
      await page.getByTestId("sidebar-nav-home").click();
      await go(page, "#/my-uno");
      await page.waitForTimeout(1500);
      await shot("my-uno");
      await go(page, "#/sites");
      await page.waitForTimeout(1500);
      await shot("apps");
    },
  },
  {
    name: "mobile",
    world: {},
    viewport: { width: 390, height: 844 },
    async run({ page, shot, step }) {
      await step("hardware on a phone, from Home's workspace pill", async () => {
        await page.getByTestId("ws-pill").click();
        await page.getByTestId("ws-hardware").waitFor({ timeout: 10_000 });
      });
      await shot("hardware");
      await step("apps on a phone", async () => {
        await page.getByTestId("ws-tab-apps").click();
        await page.getByTestId("ws-apps").waitFor();
      });
      await shot("apps");
      await step("the app card is a sheet", async () => {
        await page
          .getByTestId("ws-app-stats")
          .getByRole("button", { name: "Stats board", exact: true })
          .click();
        await page.getByTestId("ws-app-panel").waitFor({ timeout: 10_000 });
      });
      await shot("card");
    },
  },
];

const only = process.argv.slice(2);
const server = await serve();
const browser = await launch();
const report = [];
for (const flow of flows) {
  if (only.length && !only.some((name) => flow.name.startsWith(name))) continue;
  const context = await browser.newContext({
    viewport: flow.viewport ?? { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
  const result = { flow: flow.name, steps: [], errors };
  const shot = async (name) => {
    await dismissBanners(page);
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(OUT, `${flow.name}-${name}.png`) });
  };
  const step = async (title, body) => {
    const started = Date.now();
    try {
      await body();
      result.steps.push({ title, ok: true, ms: Date.now() - started });
    } catch (error) {
      result.steps.push({ title, ok: false, error: String(error).split("\n")[0].slice(0, 300) });
      await page
        .screenshot({ path: join(OUT, `${flow.name}-FAIL-${result.steps.length}.png`) })
        .catch(() => {});
    }
  };
  try {
    if (flow.viewport) {
      // A phone: the sidebar is folded, openDemo's "Assistants" isn't on screen.
      const params = new URLSearchParams({
        world: "live",
        fleet: "off",
        ...flow.world,
        speed: "3",
        panel: "closed",
      });
      await page.goto(`${server.url}?${params}`);
      await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
      await page.getByTestId("ws-pill").waitFor({ timeout: 30_000 });
    } else {
      await openDemo(page, server.url, { fleet: "off", ...flow.world });
    }
    await page.waitForTimeout(800);
    await flow.run({ page, shot, step });
  } catch (error) {
    result.steps.push({ title: "flow", ok: false, error: String(error).split("\n")[0] });
  }
  const ok = result.steps.every((item) => item.ok);
  console.log(`${ok ? "✓" : "✗"} ${flow.name}`);
  for (const item of result.steps) if (!item.ok) console.log(`   ✗ ${item.title}: ${item.error}`);
  report.push({ ...result, ok });
  await context.close();
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
server.close();
const failed = report.filter((item) => !item.ok).length;
console.log(`${report.length - failed}/${report.length} flows passed`);
process.exit(failed ? 1 : 0);
