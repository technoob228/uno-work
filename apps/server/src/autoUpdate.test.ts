import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTO_UPDATE_ATTEMPT_RETRY_MS,
  AUTO_UPDATE_FAILED_RETRY_MS,
  AUTO_UPDATE_QUIET_MS,
  AUTO_UPDATE_REMINDER_GAP_MS,
  decideAutoUpdate,
  quietSince,
  type AutoUpdateInput,
} from "./autoUpdate.ts";
import {
  makeSelfUpdateController,
  parseAutoRelease,
  parseLatestRelease,
  type UpdaterStatus,
} from "./selfUpdate.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** A quiet computer, an `auto` release ahead of it: the answer is "go". */
function input(patch: Partial<AutoUpdateInput> = {}): AutoUpdateInput {
  return {
    now: NOW,
    enabled: true,
    supported: true,
    currentVersion: "0.0.119",
    latestVersion: "0.0.120",
    autoVersion: "0.0.120",
    inProgress: false,
    lastRun: null,
    lastAttempt: null,
    runningTurns: 0,
    runningCommands: 0,
    nextWakeAt: null,
    quietSince: NOW - AUTO_UPDATE_QUIET_MS,
    ...patch,
  };
}

function run(patch: Partial<UpdaterStatus>): UpdaterStatus {
  return {
    state: "failed",
    step: null,
    error: "x",
    fromVersion: "0.0.119",
    toVersion: "0.0.120",
    rolledBack: false,
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 59 * 60_000).toISOString(),
    finishedAt: new Date(NOW - 59 * 60_000).toISOString(),
    ...patch,
  };
}

describe("decideAutoUpdate", () => {
  it("goes on a quiet computer when auto is newer and is the latest", () => {
    expect(decideAutoUpdate(input())).toEqual({ go: true, version: "0.0.120" });
  });

  it("does nothing when the owner switched it off or the computer can't update itself", () => {
    expect(decideAutoUpdate(input({ enabled: false }))).toEqual({ go: false, reason: "off" });
    expect(decideAutoUpdate(input({ supported: false }))).toEqual({
      go: false,
      reason: "unsupported",
    });
  });

  it("does nothing without an auto pointer (an older console, or not moved yet)", () => {
    expect(decideAutoUpdate(input({ autoVersion: null }))).toEqual({
      go: false,
      reason: "no-auto",
    });
  });

  it("compares versions as numbers, never goes down or sideways", () => {
    expect(decideAutoUpdate(input({ currentVersion: "0.0.120" })).go).toBe(false);
    expect(decideAutoUpdate(input({ currentVersion: "0.0.121" }))).toEqual({
      go: false,
      reason: "current",
    });
    // 0.0.99 → 0.0.100: numeric, not text order.
    expect(
      decideAutoUpdate(
        input({ currentVersion: "0.0.99", autoVersion: "0.0.100", latestVersion: "0.0.100" }),
      ),
    ).toEqual({ go: true, version: "0.0.100" });
    expect(decideAutoUpdate(input({ currentVersion: "garbage" })).go).toBe(false);
  });

  it("waits while latest is ahead of auto (a fresh promote, or auto rolled back)", () => {
    // The updater installs latest — it must be the auto release.
    expect(decideAutoUpdate(input({ latestVersion: "0.0.121" }))).toEqual({
      go: false,
      reason: "auto-behind-latest",
    });
    expect(decideAutoUpdate(input({ latestVersion: null })).go).toBe(false);
  });

  it("does not ask again while an update is asked for or running", () => {
    expect(decideAutoUpdate(input({ inProgress: true }))).toEqual({
      go: false,
      reason: "in-progress",
    });
  });

  it("never retries a version that was put back on this computer", () => {
    const rolled = run({
      rolledBack: true,
      finishedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    });
    expect(decideAutoUpdate(input({ lastRun: rolled }))).toEqual({
      go: false,
      reason: "rolled-back",
    });
    // A newer auto release is a new chance.
    expect(
      decideAutoUpdate(
        input({ lastRun: rolled, autoVersion: "0.0.121", latestVersion: "0.0.121" }),
      ),
    ).toEqual({ go: true, version: "0.0.121" });
  });

  it("waits a day after a failed run, then tries again", () => {
    const failed = run({});
    expect(decideAutoUpdate(input({ lastRun: failed }))).toEqual({
      go: false,
      reason: "failed-recently",
    });
    // Failed before it knew the version (no network): counts too.
    expect(decideAutoUpdate(input({ lastRun: run({ toVersion: null }) })).go).toBe(false);
    const old = run({
      finishedAt: new Date(NOW - AUTO_UPDATE_FAILED_RETRY_MS - 1).toISOString(),
    });
    expect(decideAutoUpdate(input({ lastRun: old })).go).toBe(true);
    // A failure for another (older) version does not hold this one back.
    expect(decideAutoUpdate(input({ lastRun: run({ toVersion: "0.0.118" }) })).go).toBe(true);
    // A successful last run is no reason to wait.
    expect(decideAutoUpdate(input({ lastRun: run({ state: "done", error: null }) })).go).toBe(true);
  });

  it("asks once per version per hour on its own", () => {
    expect(
      decideAutoUpdate(input({ lastAttempt: { version: "0.0.120", at: NOW - 60_000 } })),
    ).toEqual({ go: false, reason: "attempted" });
    expect(
      decideAutoUpdate(
        input({ lastAttempt: { version: "0.0.120", at: NOW - AUTO_UPDATE_ATTEMPT_RETRY_MS } }),
      ).go,
    ).toBe(true);
    expect(
      decideAutoUpdate(input({ lastAttempt: { version: "0.0.119", at: NOW - 60_000 } })).go,
    ).toBe(true);
  });

  it("never while an agent works or a command still runs", () => {
    expect(decideAutoUpdate(input({ runningTurns: 1 }))).toEqual({ go: false, reason: "busy" });
    expect(decideAutoUpdate(input({ runningCommands: 2 }))).toEqual({
      go: false,
      reason: "busy",
    });
  });

  it("waits for the quiet period (before economy sleeps the computer at 10 minutes)", () => {
    expect(AUTO_UPDATE_QUIET_MS).toBeLessThan(10 * 60_000);
    expect(decideAutoUpdate(input({ quietSince: NOW - AUTO_UPDATE_QUIET_MS + 1 }))).toEqual({
      go: false,
      reason: "recent-activity",
    });
  });

  it("not with a reminder due within 15 minutes", () => {
    const soon = new Date(NOW + AUTO_UPDATE_REMINDER_GAP_MS - 1).toISOString();
    expect(decideAutoUpdate(input({ nextWakeAt: soon }))).toEqual({
      go: false,
      reason: "reminder-soon",
    });
    const later = new Date(NOW + AUTO_UPDATE_REMINDER_GAP_MS + 1).toISOString();
    expect(decideAutoUpdate(input({ nextWakeAt: later })).go).toBe(true);
    expect(decideAutoUpdate(input({ nextWakeAt: "not a date" })).go).toBe(true);
  });
});

describe("quietSince", () => {
  it("is the latest of start, wake, input and work", () => {
    expect(
      quietSince({ startedAt: 10, lastWokeAt: null, lastInputAt: null, lastBusyAt: null }),
    ).toBe(10);
    expect(quietSince({ startedAt: 10, lastWokeAt: 40, lastInputAt: 20, lastBusyAt: 30 })).toBe(40);
    expect(quietSince({ startedAt: 10, lastWokeAt: 15, lastInputAt: 50, lastBusyAt: 30 })).toBe(50);
    expect(quietSince({ startedAt: 10, lastWokeAt: 15, lastInputAt: 20, lastBusyAt: 60 })).toBe(60);
  });
});

const SHA_119 = "1".repeat(64);
const SHA_120 = "2".repeat(64);

describe("auto pointer in SHA256SUMS", () => {
  const base = [
    `${SHA_119}  uno-work-server-0.0.119.tar.gz`,
    `${SHA_119}  uno-work-server-latest.tar.gz`,
    `${SHA_120}  uno-work-server-0.0.120.tar.gz`,
    `${SHA_120}  uno-work-server-latest.tar.gz`,
  ];

  it("is absent on a list without it (no automatic updates, not an error)", () => {
    const sums = base.join("\n");
    expect(parseAutoRelease(sums)).toBeNull();
    expect(parseLatestRelease(sums)?.version).toBe("0.0.120");
  });

  it("follows its last line and does not change what latest is", () => {
    const sums = [
      ...base,
      `${SHA_119}  uno-work-server-auto.tar.gz`,
      `${SHA_120}  uno-work-server-auto.tar.gz`,
    ].join("\n");
    expect(parseAutoRelease(sums)?.version).toBe("0.0.120");
    expect(parseLatestRelease(sums)?.version).toBe("0.0.120");
    // `auto rollback` appends the previous line again.
    expect(parseAutoRelease(`${sums}\n${SHA_119}  uno-work-server-auto.tar.gz\n`)?.version).toBe(
      "0.0.119",
    );
  });

  it("the controller reads both pointers from one request; nothing without paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "uno-auto-update-"));
    mkdirSync(join(root, "status"));
    const calls: string[] = [];
    const sums = [...base, `${SHA_119}  uno-work-server-auto.tar.gz`].join("\n");
    const controller = makeSelfUpdateController({
      paths: {
        requestFile: join(root, "ask", "request"),
        statusFile: join(root, "status", "status.json"),
        baseUrl: "https://console.uno.place/cli/work",
      },
      currentVersion: "0.0.119",
      fetchImpl: (async (url: unknown) => {
        calls.push(String(url));
        return new Response(sums, { status: 200 });
      }) as unknown as typeof fetch,
      now: () => NOW,
    });
    const releases = await controller.releases();
    expect(releases.latest?.version).toBe("0.0.120");
    expect(releases.auto?.version).toBe("0.0.119");
    await controller.status({ canUpdate: true });
    expect(calls).toHaveLength(1);

    const none = makeSelfUpdateController({ paths: null, currentVersion: "0.0.119" });
    expect(none.supported).toBe(false);
    expect(await none.releases()).toEqual({ latest: null, auto: null });
    expect(await none.inProgress()).toBe(false);
    await expect(none.requestAutomatic()).rejects.toThrow();
  });

  it("requestAutomatic drops the button's request file; inProgress sees it and a running updater", async () => {
    const root = mkdtempSync(join(tmpdir(), "uno-auto-update-"));
    mkdirSync(join(root, "status"));
    const statusFile = join(root, "status", "status.json");
    const controller = makeSelfUpdateController({
      paths: { requestFile: join(root, "ask", "request"), statusFile, baseUrl: "https://x.test" },
      currentVersion: "0.0.119",
      now: () => NOW,
    });
    expect(await controller.inProgress()).toBe(false);
    await controller.requestAutomatic();
    expect(await controller.inProgress()).toBe(true);

    const other = makeSelfUpdateController({
      paths: { requestFile: join(root, "none", "request"), statusFile, baseUrl: "https://x.test" },
      currentVersion: "0.0.119",
      now: () => NOW,
    });
    writeFileSync(
      statusFile,
      JSON.stringify({ state: "updating", startedAt: new Date(NOW - 60_000).toISOString() }),
    );
    expect(await other.inProgress()).toBe(true);
    // An updater silent for 40+ minutes is not "running" any more.
    writeFileSync(
      statusFile,
      JSON.stringify({ state: "updating", startedAt: new Date(NOW - 41 * 60_000).toISOString() }),
    );
    expect(await other.inProgress()).toBe(false);
  });
});
