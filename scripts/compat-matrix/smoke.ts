/**
 * The browser smoke of one matrix row: the fresh web build, served by the
 * origin proxy, against one daemon.
 *
 * One page, no reloads (every step is a click), so the WebSocket opened at
 * load is the one that must still be open at the end. Each check answers one
 * question a person would ask; anything the page throws while a check runs
 * fails that check.
 *
 * The Update button of the notice is never pressed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Browser, Page } from "playwright";

import { compareVersions, type DaemonDescriptor } from "./daemons.ts";
import {
  describeMachineProblems,
  emptyRpcSocketState,
  emptyRpcTraffic,
  findRawError,
  judgeRpcMethods,
  judgeTurnOutcome,
  recordRpcFrame,
  refusedCommands,
  unexplainedMachineProblems,
} from "./findings.ts";
import { ACCESS_COOKIE, type OriginProxyStats } from "./originProxy.ts";

export const CHECKS = [
  { id: "load", title: "App loads" },
  { id: "chats", title: "Chats list" },
  { id: "send", title: "New chat + message" },
  { id: "files", title: "Files" },
  { id: "settings", title: "Settings" },
  { id: "ws", title: "WebSocket 30 s" },
  { id: "notice", title: "Update notice" },
  { id: "degrade", title: "Missing features degrade" },
  { id: "rpc", title: "RPC methods known" },
] as const;

export type CheckId = (typeof CHECKS)[number]["id"];

export interface CheckResult {
  readonly status: "pass" | "fail";
  /** Why it failed, or what exactly was seen. */
  readonly reason: string;
  /** Rough spots that are not a version gap: shown in the report, never ❌. */
  readonly notes: ReadonlyArray<string>;
}

export type SmokeResults = Record<CheckId, CheckResult>;

export const SMOKE_MESSAGE = "Compat matrix: say hello in one word";

const THREAD_URL = /\/[0-9a-f]{8}-[0-9a-f-]{27}\/[0-9a-f]{8}-[0-9a-f-]{27}\/?$/;
/** Notices a chat shows instead of an answer (sign in again, try again …). */
const CHAT_NOTICES =
  '[data-testid="turn-error-notice"], [role="status"]:not([data-testid="stale-bundle-notice"])';

export interface SmokeInput {
  readonly browser: Browser;
  /** The origin proxy, e.g. `http://127.0.0.1:13922`. */
  readonly baseUrl: string;
  /** The proxy's access cookie value (see `OriginProxyOptions.accessToken`). */
  readonly accessToken: string;
  readonly descriptor: DaemonDescriptor;
  /** Version of the fresh web build. */
  readonly webVersion: string;
  readonly proxyStats: OriginProxyStats;
  /** How many RPC methods the fresh web has. */
  readonly rpcMethodCount: number;
  /** Those of them that are missing from this daemon's bundle. */
  readonly rpcMethodsMissing: ReadonlyArray<string>;
  /**
   * `/api` routes of the fresh web that this daemon lacks: `ungated` have no
   * feature flag (a 404 for a person), `gated` are hidden by one. Null when
   * there was no daemon of this checkout to compare with.
   */
  readonly httpRoutes: {
    readonly ungated: ReadonlyArray<string>;
    readonly gated: ReadonlyArray<string>;
  } | null;
  readonly screenshotDir: string;
  /** How long the socket must stay open (30 s). */
  readonly wsHoldMs: number;
}

const pass = (reason: string, notes: ReadonlyArray<string> = []): CheckResult => ({
  status: "pass",
  reason,
  notes,
});
export const failed = (reason: string): CheckResult => ({ status: "fail", reason, notes: [] });

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n", 1)[0] ?? text).slice(0, 300);
}

async function visibleText(page: Page, selector = "body"): Promise<string> {
  try {
    return (await page.locator(selector).first().innerText({ timeout: 3_000 })).replace(
      /\n{2,}/g,
      "\n",
    );
  } catch {
    return "";
  }
}

/** The root error screen or an empty page: the interface itself broke. */
async function crashOnScreen(page: Page): Promise<string | null> {
  const text = await visibleText(page);
  if (text.trim().length === 0) return "the page is blank";
  if (text.includes("Something went wrong.")) return 'the page shows "Something went wrong."';
  return null;
}

async function waitForSettledText(page: Page, selector: string, maxMs: number): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const text = await visibleText(page, selector);
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3_000) {
      break;
    }
    await page.waitForTimeout(500);
  }
  return last;
}

export async function runSmoke(input: SmokeInput): Promise<SmokeResults> {
  mkdirSync(input.screenshotDir, { recursive: true });
  const daemonVersion = input.descriptor.serverVersion;
  const context = await input.browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.addCookies([
    { name: ACCESS_COOKIE, value: input.accessToken, url: input.baseUrl, httpOnly: true },
  ]);
  const page = await context.newPage();
  const running: { id: CheckId } = { id: "load" };
  const uncaught: Array<{ readonly during: CheckId; readonly text: string }> = [];
  const traffic = emptyRpcTraffic();
  const sockets = { opened: 0, closed: 0, firstOpenedAt: 0 };

  page.on("pageerror", (error) => {
    uncaught.push({ during: running.id, text: error.message.slice(0, 200) });
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws") return;
    sockets.opened += 1;
    if (sockets.firstOpenedAt === 0) sockets.firstOpenedAt = Date.now();
    const state = emptyRpcSocketState();
    socket.on("framesent", (frame) => recordRpcFrame(traffic, state, "sent", frame.payload));
    socket.on("framereceived", (frame) =>
      recordRpcFrame(traffic, state, "received", frame.payload),
    );
    socket.on("close", () => {
      sockets.closed += 1;
    });
  });

  const results: Partial<SmokeResults> = {};
  let shot = 0;
  const screenshot = async (name: string) => {
    shot += 1;
    await page
      .screenshot({
        path: join(input.screenshotDir, `${String(shot).padStart(2, "0")}-${name}.png`),
      })
      .catch(() => undefined);
  };
  /** Runs one check; a thrown step, an uncaught page error or a crash screen fails it. */
  const check = async (id: CheckId, body: () => Promise<CheckResult>) => {
    running.id = id;
    let result: CheckResult;
    try {
      result = await body();
    } catch (error) {
      result = failed(errorText(error));
    }
    await page.waitForTimeout(300);
    const thrown = uncaught.filter((entry) => entry.during === id);
    const crash = await crashOnScreen(page);
    if (result.status === "pass" && thrown.length > 0) {
      result = failed(`uncaught error in the page: ${thrown[0]?.text ?? ""}`);
    }
    if (result.status === "pass" && crash) result = failed(crash);
    await screenshot(id);
    results[id] = result;
    return result.status === "pass";
  };

  try {
    const loaded = await check("load", async () => {
      const response = await page.goto(`${input.baseUrl}/`, { waitUntil: "domcontentloaded" });
      const servedBy = response?.headers()["x-uno-ui"] ?? "";
      if (!servedBy.startsWith("origin")) {
        throw new Error(`index.html did not come from our address (X-Uno-UI: "${servedBy}")`);
      }
      await page.getByTestId("sidebar-nav-home").waitFor({ state: "visible", timeout: 45_000 });
      const meta = await page
        .locator('meta[name="uno-ui"]')
        .first()
        .getAttribute("content", { timeout: 5_000 })
        .catch(() => null);
      if (meta !== "origin") throw new Error(`the uno-ui meta is ${JSON.stringify(meta)}`);
      if (input.proxyStats.served.asset === 0) {
        throw new Error("no asset came from the fresh build");
      }
      return pass(`interface ${input.webVersion} from our address, computer ${daemonVersion}`);
    });
    if (!loaded) {
      for (const id of ["chats", "send", "files", "settings", "ws", "notice", "degrade"] as const) {
        results[id] = failed("not reached: the app did not load");
      }
    } else {
      await check("notice", async () => {
        const notice = page.getByTestId("stale-bundle-notice");
        const order = compareVersions(daemonVersion, input.webVersion);
        if (order === 0) {
          await page.waitForTimeout(3_000);
          if ((await notice.count()) > 0) {
            throw new Error(
              `a notice is shown for the same version: "${await notice.innerText()}"`,
            );
          }
          return pass("same version number as the interface: no notice, as it should be");
        }
        try {
          await notice.waitFor({ state: "visible", timeout: 20_000 });
        } catch {
          throw new Error(
            `no notice for a computer on ${daemonVersion} under the interface ${input.webVersion}`,
          );
        }
        const text = (await notice.innerText()).replace(/\s*\n+\s*/g, " / ");
        const button = (await page.getByTestId("stale-bundle-notice-action").innerText()).trim();
        if (order < 0) {
          if (!text.includes(`runs Uno Work ${daemonVersion}`) || button !== "Update") {
            throw new Error(
              `expected "… runs Uno Work ${daemonVersion}" with Update, got "${text}"`,
            );
          }
        } else if (button !== "Reload") {
          throw new Error(`a newer computer should offer Reload, got "${text}"`);
        }
        return pass(`"${text}"`);
      });

      await check("chats", async () => {
        await page.getByTestId("sidebar-d-chats").waitFor({ state: "visible", timeout: 15_000 });
        await page
          .getByTestId("sidebar-chats-loading")
          .waitFor({ state: "hidden", timeout: 15_000 });
        const rows = await page.getByTestId("sidebar-row-d").count();
        if (rows === 0 && !/No chats yet/i.test(await visibleText(page))) {
          throw new Error("the chats list shows neither chats nor its empty state");
        }
        return pass(rows === 0 ? "empty list rendered" : `${rows} chat(s) rendered`);
      });

      const sent = await check("send", async () => {
        const composer = page.getByTestId("home-composer");
        await composer.waitFor({ state: "visible", timeout: 15_000 });
        await composer.click();
        await page.keyboard.type(SMOKE_MESSAGE);
        await page.keyboard.press("Enter");
        await page.waitForURL(THREAD_URL, { timeout: 30_000 });
        await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 20_000 });
        await page.locator("main").getByText(SMOKE_MESSAGE).first().waitFor({ timeout: 20_000 });
        await page
          .getByTestId("sidebar-row-d")
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });
        const chat = await waitForSettledText(page, "main", 40_000);
        const outcome = judgeTurnOutcome({
          notices: await page.locator(CHAT_NOTICES).allInnerTexts(),
          chatAfterMessage: chat.slice(chat.indexOf(SMOKE_MESSAGE) + SMOKE_MESSAGE.length),
        });
        if (!outcome.ok) throw new Error(outcome.reason);
        const refused = refusedCommands(traffic);
        if (refused.length > 0) {
          throw new Error(`the computer refused a command of the interface: ${refused[0] ?? ""}`);
        }
        return pass(outcome.reason, outcome.notes);
      });

      await check("files", async () => {
        await page.getByTestId("sidebar-nav-files").click();
        await page.waitForURL(/\/files(?:[/?#]|$)/, { timeout: 15_000 });
        await page
          .getByTestId("files-location-note")
          .waitFor({ state: "visible", timeout: 20_000 });
        await page.getByText("Name", { exact: true }).first().waitFor({ timeout: 20_000 });
        await page.waitForTimeout(1_500);
        const raw = findRawError(await visibleText(page, "main"));
        if (raw) throw new Error(`Files shows ${raw}`);
        return pass("the file list of the computer rendered");
      });

      await check("settings", async () => {
        await page.getByTestId("sidebar-account").click();
        await page
          .getByTestId("sidebar-account-menu")
          .waitFor({ state: "visible", timeout: 10_000 });
        await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await page.waitForURL(/\/settings(?:\/|$)/, { timeout: 15_000 });
        const seen: Array<string> = [];
        for (const section of [
          "Account & plan",
          "AI",
          "Assistants & phone",
          "Computer",
          "Developer",
        ]) {
          await page.getByRole("button", { name: section, exact: true }).first().click();
          await page.waitForTimeout(1_800);
          const text = await visibleText(page, "main");
          if (text.trim().length < 40) throw new Error(`Settings → ${section} is empty`);
          const raw = findRawError(text);
          if (raw) throw new Error(`Settings → ${section} shows ${raw}`);
          const crash = await crashOnScreen(page);
          if (crash) throw new Error(`Settings → ${section}: ${crash}`);
          await screenshot(`settings-${section.toLowerCase().replace(/[^a-z]+/g, "-")}`);
          seen.push(section);
        }
        await page.getByRole("button", { name: "Back", exact: true }).first().click();
        await page.getByTestId("sidebar-nav-home").waitFor({ state: "visible", timeout: 15_000 });
        return pass(`sections opened: ${seen.join(", ")}`);
      });

      await check("degrade", async () => {
        // More screens, so more of the daemon's routes are asked for.
        await page.getByTestId("sidebar-nav-apps").click();
        await page.waitForTimeout(2_500);
        let crash = await crashOnScreen(page);
        if (crash) throw new Error(`Apps & sites: ${crash}`);
        await page.getByTestId("sidebar-uno").click();
        await page.waitForTimeout(2_500);
        crash = await crashOnScreen(page);
        if (crash) throw new Error(`Uno: ${crash}`);

        // A feature a daemon may not have: "Don't let agents write here"
        // (capability agentsCloseChat, since 0.0.115). Without it the chat
        // menu must not offer it; with it, it must.
        const seen: Array<string> = [];
        if (sent) {
          const row = page.getByTestId("sidebar-row-d").first();
          await row.click({ button: "right" });
          await page.getByText("Rename chat", { exact: true }).waitFor({ timeout: 10_000 });
          const offered =
            (await page.getByText("Don't let agents write here", { exact: true }).count()) > 0;
          const supported = input.descriptor.capabilities["agentsCloseChat"] === true;
          await screenshot("chat-menu");
          await page.keyboard.press("Escape");
          if (offered !== supported) {
            throw new Error(
              supported
                ? 'the computer supports "Don\'t let agents write here" and the chat menu does not offer it'
                : 'the chat menu offers "Don\'t let agents write here" and this computer cannot do it',
            );
          }
          seen.push(
            supported
              ? '"Don\'t let agents write here" is in the chat menu (the computer supports it)'
              : '"Don\'t let agents write here" is hidden (this computer cannot do it)',
          );
          await row.click();
          await page.waitForURL(THREAD_URL, { timeout: 15_000 });
          await page.waitForTimeout(1_500);
        }

        const problems = unexplainedMachineProblems(input.proxyStats.machineProblems);
        if (problems.length > 0) {
          throw new Error(
            `the computer refused what the interface asked: ${describeMachineProblems(problems)}`,
          );
        }
        if (traffic.defects.length > 0) {
          throw new Error(
            `the computer failed on a request the page was waiting for: ${[...new Set(traffic.defects)].slice(0, 3).join("; ")}`,
          );
        }
        const refused = refusedCommands(traffic);
        if (refused.length > 0) {
          throw new Error(
            `the computer refused a command of the interface: ${[...new Set(refused)].slice(0, 3).join("; ")}`,
          );
        }
        seen.push("every route and request the interface used was answered");
        if (input.httpRoutes !== null) {
          if (input.httpRoutes.ungated.length > 0) {
            throw new Error(
              `the interface can call routes this computer does not have, with no feature flag to hide them: ${input.httpRoutes.ungated.slice(0, 6).join(", ")}`,
            );
          }
          seen.push(
            input.httpRoutes.gated.length === 0
              ? "the daemon has every /api route the interface can call"
              : `routes it lacks are behind feature flags: ${input.httpRoutes.gated.join(", ")}`,
          );
        }
        return pass(seen.join("; "), [
          ...[...new Set(traffic.defectsAfterCancel)].map(
            (defect) => `the daemon failed on a subscription the page had already left: ${defect}`,
          ),
          ...[...new Set(traffic.refusals.map((refusal) => `${refusal.method}: ${refusal.text}`))]
            .slice(0, 6)
            .map(
              (refusal) =>
                `the daemon said no to a request (its own error, shown by the interface): ${refusal}`,
            ),
        ]);
      });

      await check("ws", async () => {
        if (sockets.opened === 0) throw new Error("the page never opened /ws");
        const remaining = sockets.firstOpenedAt + input.wsHoldMs - Date.now();
        if (remaining > 0) await page.waitForTimeout(remaining);
        const heldSeconds = Math.round((Date.now() - sockets.firstOpenedAt) / 1000);
        if (sockets.closed > 0 || sockets.opened > 1) {
          throw new Error(
            `the connection dropped: ${sockets.opened} opened, ${sockets.closed} closed in ${heldSeconds} s`,
          );
        }
        return pass(`one connection, open for ${heldSeconds} s`);
      });
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  // Static and observed together: a method the page may call that this daemon
  // has never heard of ends the connection (the daemon answers with a
  // connection-level defect).
  const rpc = judgeRpcMethods({
    methodCount: input.rpcMethodCount,
    missing: input.rpcMethodsMissing,
    sent: traffic.sent,
  });
  results.rpc = rpc.ok ? pass(rpc.reason) : failed(rpc.reason);

  const complete = {} as SmokeResults;
  for (const { id } of CHECKS) complete[id] = results[id] ?? failed("not run");
  return complete;
}
