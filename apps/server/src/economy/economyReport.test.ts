import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ECONOMY_REPORT_INTERVAL_MS,
  ECONOMY_TICK_MS,
  buildReportBody,
  countRunningTurns,
  detectWake,
  earliestFuture,
  presenceFromConsole,
  probeSignature,
  readKeepAwakeApps,
  shouldReport,
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
