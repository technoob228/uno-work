import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APPS_RESEND_MS,
  ECONOMY_REPORT_INTERVAL_MS,
  ECONOMY_TICK_MS,
  REPORT_APPS_MAX,
  appsSignature,
  buildReportBody,
  buildReportedApps,
  countRunningTurns,
  detectWake,
  earliestFuture,
  presenceFromConsole,
  probeSignature,
  readKeepAwakeApps,
  shouldReport,
  shouldSendApps,
  type AppForReport,
  type EconomyProbe,
} from "./economyReport.ts";

const idle: EconomyProbe = {
  clients: 0,
  runningTurns: 0,
  runningTerminals: 0,
  keepAwake: [],
  nextWakeAt: null,
};

describe("economy report", () => {
  it("builds the console body, omitting unknowns", () => {
    expect(buildReportBody(idle, null)).toEqual({
      clients: 0,
      running_turns: 0,
      running_terminals: 0,
      keep_awake: [],
    });
    const body = buildReportBody(
      { ...idle, clients: 2, runningTurns: 1, nextWakeAt: "2026-09-26T08:00:00.000Z" },
      Date.parse("2026-09-25T20:00:00.000Z"),
    );
    expect(body.last_input_at).toBe("2026-09-25T20:00:00.000Z");
    expect(body.next_wake_at).toBe("2026-09-26T08:00:00.000Z");
    expect(body.running_turns).toBe(1);
  });

  it("signature changes only when the verdict could change", () => {
    const one = probeSignature({ ...idle, runningTurns: 1 });
    expect(probeSignature({ ...idle, runningTurns: 3 })).toBe(one);
    expect(probeSignature(idle)).not.toBe(one);
    expect(probeSignature({ ...idle, keepAwake: ["app:b", "app:a"] })).toBe(
      probeSignature({ ...idle, keepAwake: ["app:a", "app:b"] }),
    );
  });

  it("reports first, on change, on wake, every minute, and when the person is back right before sleep", () => {
    const base = {
      now: 1_000_000,
      lastSentAt: 1_000_000 - 5_000,
      lastSignature: "s",
      signature: "s",
      woke: false,
      inputSinceSent: false,
      sleepAfter: null,
    };
    expect(shouldReport({ ...base, lastSentAt: null })).toBe(true);
    expect(shouldReport(base)).toBe(false);
    expect(shouldReport({ ...base, signature: "t" })).toBe(true);
    expect(shouldReport({ ...base, woke: true })).toBe(true);
    expect(shouldReport({ ...base, lastSentAt: base.now - ECONOMY_REPORT_INTERVAL_MS })).toBe(true);
    expect(
      shouldReport({ ...base, inputSinceSent: true, sleepAfter: base.now + ECONOMY_TICK_MS }),
    ).toBe(true);
    expect(
      shouldReport({ ...base, inputSinceSent: true, sleepAfter: base.now + 10 * 60_000 }),
    ).toBe(false);
  });

  it("detects a frozen gap between ticks", () => {
    expect(detectWake(null, 10_000)).toBe(false);
    expect(detectWake(0, ECONOMY_TICK_MS + 1_000)).toBe(false);
    expect(detectWake(0, 5 * 60_000)).toBe(true);
  });

  it("turns the console answer into presence", () => {
    const presence = presenceFromConsole(
      {
        enabled: true,
        state: "awake",
        sleep_after: "2026-09-25T20:10:00Z",
        idle_timeout_s: 600,
        busy: ["agent:1"],
      },
      0,
    );
    expect(presence).toMatchObject({
      enabled: true,
      state: "awake",
      sleepAfter: "2026-09-25T20:10:00Z",
      idleTimeoutS: 600,
      busy: ["agent:1"],
    });
    expect(presenceFromConsole({ error: "ECONOMY_MODE_UNAVAILABLE" }, 0)).toBeNull();
  });

  it("picks the earliest future time", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(
      earliestFuture(
        ["2026-09-25T11:00:00Z", "2026-09-25T15:00:00Z", "2026-09-25T13:00:00Z", "junk"],
        now,
      ),
    ).toBe("2026-09-25T13:00:00.000Z");
    expect(earliestFuture([], now)).toBeNull();
  });
});

describe("readKeepAwakeApps", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('lists only apps with "runs": "always"', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "economy-apps-"));
    const apps = path.join(dir, ".uno", "apps");
    await mkdir(apps, { recursive: true });
    await writeFile(path.join(apps, "bot.json"), JSON.stringify({ id: "bot", runs: "always" }));
    await writeFile(path.join(apps, "site.json"), JSON.stringify({ id: "site" }));
    await writeFile(path.join(apps, "worker.json"), JSON.stringify({ runs: "always" }));
    await writeFile(path.join(apps, "broken.json"), "{nope");
    await writeFile(path.join(apps, "notes.png"), "png");
    expect(await readKeepAwakeApps(apps)).toEqual(["app:bot", "app:worker"]);
    expect(await readKeepAwakeApps(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("countRunningTurns", () => {
  it("counts running projection rows that have a live adapter session", () => {
    expect(countRunningTurns(["a", "b"], ["a"])).toBe(1);
    expect(countRunningTurns(["a"], [])).toBe(0);
  });
  it("ignores running rows left over from a daemon restart", () => {
    expect(countRunningTurns([], ["a", "b"])).toBe(0);
    expect(countRunningTurns(["b"], ["a"])).toBe(0);
  });
});

const app = (over: Partial<AppForReport>): AppForReport => ({
  id: "manifest:notes",
  source: "manifest",
  name: "Notes",
  icon: "📝",
  port: 3000,
  status: "running",
  http: true,
  manifest: { id: "notes" },
  ...over,
});

describe("apps in the report", () => {
  it("sends registered apps first, then found ones, with only the listed fields", () => {
    const scanned = [
      app({
        id: "port:8080",
        source: "port",
        name: "node",
        icon: null,
        port: 8080,
        manifest: null,
        // Whatever else a scanned app carries must not leak into the report.
        ...({
          detail: "node server.js --token=sk-secret",
          localUrl: "http://localhost:8080/",
        } as {}),
      }),
      app({}),
      app({
        id: "manifest:bot",
        name: "Café Bot",
        icon: null,
        port: null,
        status: "unknown",
        http: false,
        manifest: { id: "bot", telegramBot: { username: "cafe_bot", tokenEnv: null } },
      }),
      app({
        id: "manifest:worker",
        name: "Queue",
        port: null,
        status: "stopped",
        http: false,
        manifest: { id: "worker" },
      }),
    ];
    const out = buildReportedApps(scanned, ["app:bot"]);
    expect(out).toEqual([
      { id: "bot", name: "Café Bot", runs: "always", kind: "bot" },
      { id: "notes", name: "Notes", icon: "📝", port: 3000, running: true, kind: "web" },
      { id: "worker", name: "Queue", icon: "📝", running: false, kind: "service" },
      { id: "port:8080", name: "node", port: 8080, running: true, kind: "web", found: true },
    ]);
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("localhost");
  });

  it("leaves out hidden programs and Uno's own / App Store containers", () => {
    const out = buildReportedApps(
      [
        app({ id: "docker:uno-wiki", source: "docker", manifest: null, canRemove: false }),
        app({ id: "docker:mine", source: "docker", name: "Mine", manifest: null, canRemove: true }),
        app({ id: "port:9000", source: "port", manifest: null, hidden: true }),
      ],
      [],
    );
    expect(out.map((a) => a.id)).toEqual(["docker:mine"]);
  });

  it("caps the list and clips names and icons, stripping control characters", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      app({ id: `manifest:a${i}`, manifest: { id: `a${String(i).padStart(2, "0")}` } }),
    );
    expect(buildReportedApps(many, [])).toHaveLength(REPORT_APPS_MAX);
    const [long] = buildReportedApps(
      [app({ name: `\u202e${"x".repeat(200)}\u0000`, icon: "🙂".repeat(40), port: 70000 })],
      [],
    );
    expect(long?.name).toBe("x".repeat(64));
    expect(Array.from(long?.icon ?? "")).toHaveLength(16);
    expect(long?.port).toBeUndefined();
  });

  it("puts apps into the body only when given; absent is not an empty list", () => {
    expect(buildReportBody(idle, null)).not.toHaveProperty("apps");
    expect(buildReportBody(idle, null, []).apps).toEqual([]);
  });

  it("sends the list first, on change, and every few minutes", () => {
    const sig = appsSignature([{ id: "notes", name: "Notes", kind: "web" }]);
    const base = {
      now: 1_000_000,
      lastAppsSentAt: 1_000_000 - 60_000,
      lastAppsSignature: sig,
      signature: sig,
    };
    expect(shouldSendApps({ ...base, lastAppsSentAt: null, lastAppsSignature: null })).toBe(true);
    expect(shouldSendApps(base)).toBe(false);
    expect(shouldSendApps({ ...base, signature: appsSignature([]) })).toBe(true);
    expect(shouldSendApps({ ...base, lastAppsSentAt: base.now - APPS_RESEND_MS })).toBe(true);
  });
});
