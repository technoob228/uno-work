import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  makeSelfUpdateController,
  type SelfUpdateStatus,
  type UpdaterStatus,
} from "./selfUpdate.ts";
import {
  UPDATE_LATER_MAX_AHEAD_MS,
  UPDATE_LATER_QUIET_MS,
  UPDATE_LATER_REMINDER_GAP_MS,
  clampNotBefore,
  clearUpdateLater,
  decideUpdateLater,
  economySignalsFor,
  parseUpdateLater,
  quietSince,
  readUpdateLater,
  statusWithLater,
  writeUpdateLater,
  type UpdateLaterInput,
} from "./selfUpdateLater.ts";

const NOW = Date.parse("2026-10-10T18:30:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const EVENING = new Date(NOW - 30 * 60_000).toISOString();

/** The owner said "This evening", the time has come, the computer is quiet: "go". */
function input(patch: Partial<UpdateLaterInput> = {}): UpdateLaterInput {
  return {
    now: NOW,
    later: { version: "0.0.120", notBefore: EVENING },
    supported: true,
    currentVersion: "0.0.119",
    latestVersion: "0.0.120",
    inProgress: false,
    lastRun: null,
    runningTurns: 0,
    runningCommands: 0,
    nextReminderAt: null,
    quietSince: NOW - UPDATE_LATER_QUIET_MS,
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

describe("decideUpdateLater", () => {
  it("never updates by itself when the owner did not say so", () => {
    expect(decideUpdateLater(input({ later: null }))).toEqual({ go: false, reason: "not-asked" });
    // Not even on a computer that has been quiet for a week with a release out.
    expect(decideUpdateLater(input({ later: null, quietSince: NOW - 7 * 86_400_000 })).go).toBe(
      false,
    );
  });

  it("goes after the time the owner chose, on a quiet computer", () => {
    expect(decideUpdateLater(input())).toEqual({ go: true, version: "0.0.120" });
  });

  it("waits for that time", () => {
    const notBefore = new Date(NOW + 1).toISOString();
    expect(decideUpdateLater(input({ later: { version: "0.0.120", notBefore } }))).toEqual({
      go: false,
      reason: "not-yet",
    });
    expect(
      decideUpdateLater(
        input({ later: { version: "0.0.120", notBefore: new Date(NOW).toISOString() } }),
      ).go,
    ).toBe(true);
  });

  it("installs whatever is latest by then: the word is for 'the update'", () => {
    expect(decideUpdateLater(input({ latestVersion: "0.0.121" }))).toEqual({
      go: true,
      version: "0.0.121",
    });
  });

  it("has nothing to do once the computer is on that version, or the release is gone", () => {
    // Updated in the meantime (the button, the console).
    expect(decideUpdateLater(input({ currentVersion: "0.0.120" }))).toEqual({
      go: false,
      reason: "current",
    });
    expect(
      decideUpdateLater(input({ currentVersion: "0.0.121", latestVersion: "0.0.121" })),
    ).toEqual({ go: false, reason: "current" });
    // The release was withdrawn: latest is back at what the computer runs.
    expect(decideUpdateLater(input({ latestVersion: "0.0.119" }))).toEqual({
      go: false,
      reason: "current",
    });
    // 0.0.99 → 0.0.100: numbers, not text order.
    expect(
      decideUpdateLater(
        input({
          currentVersion: "0.0.99",
          latestVersion: "0.0.100",
          later: { version: "0.0.100", notBefore: EVENING },
        }),
      ),
    ).toEqual({ go: true, version: "0.0.100" });
  });

  it("looks again later when the console's list can't be read", () => {
    expect(decideUpdateLater(input({ latestVersion: null }))).toEqual({
      go: false,
      reason: "no-release",
    });
  });

  it("does not ask again while an update is asked for or running", () => {
    expect(decideUpdateLater(input({ inProgress: true }))).toEqual({
      go: false,
      reason: "in-progress",
    });
  });

  it("never retries a version that was put back on this computer", () => {
    const rolled = run({
      rolledBack: true,
      finishedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    });
    expect(decideUpdateLater(input({ lastRun: rolled }))).toEqual({
      go: false,
      reason: "rolled-back",
    });
    // Known before the evening too: the promise must not stay on the screen.
    expect(
      decideUpdateLater(
        input({
          lastRun: rolled,
          later: { version: "0.0.120", notBefore: new Date(NOW + 3_600_000).toISOString() },
        }),
      ),
    ).toEqual({ go: false, reason: "rolled-back" });
    // A newer release is a new chance.
    expect(decideUpdateLater(input({ lastRun: rolled, latestVersion: "0.0.121" }))).toEqual({
      go: true,
      version: "0.0.121",
    });
    // A run that failed without touching the computer (no network) is not "put back":
    // the owner said "This evening" after seeing it.
    expect(decideUpdateLater(input({ lastRun: run({}) })).go).toBe(true);
  });

  it("never while an agent works or a command still runs", () => {
    expect(decideUpdateLater(input({ runningTurns: 1 }))).toEqual({ go: false, reason: "busy" });
    expect(decideUpdateLater(input({ runningCommands: 2 }))).toEqual({
      go: false,
      reason: "busy",
    });
  });

  it("waits for a few quiet minutes", () => {
    expect(decideUpdateLater(input({ quietSince: NOW - UPDATE_LATER_QUIET_MS + 1 }))).toEqual({
      go: false,
      reason: "recent-activity",
    });
  });

  it("not with a reminder due within 15 minutes", () => {
    const soon = new Date(NOW + UPDATE_LATER_REMINDER_GAP_MS - 1).toISOString();
    expect(decideUpdateLater(input({ nextReminderAt: soon }))).toEqual({
      go: false,
      reason: "reminder-soon",
    });
    const far = new Date(NOW + UPDATE_LATER_REMINDER_GAP_MS + 1).toISOString();
    expect(decideUpdateLater(input({ nextReminderAt: far })).go).toBe(true);
    expect(decideUpdateLater(input({ nextReminderAt: "not a date" })).go).toBe(true);
  });

  it("can't on a computer without self-update", () => {
    expect(decideUpdateLater(input({ supported: false }))).toEqual({
      go: false,
      reason: "unsupported",
    });
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

describe("the owner's word on disk", () => {
  it("survives a restart, and goes when cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uno-update-later-"));
    expect(await readUpdateLater(dir)).toBeNull();
    await writeUpdateLater(dir, { version: "0.0.120", notBefore: EVENING });
    expect(await readUpdateLater(dir)).toEqual({ version: "0.0.120", notBefore: EVENING });
    await clearUpdateLater(dir);
    expect(await readUpdateLater(dir)).toBeNull();
    await clearUpdateLater(dir); // twice is fine
  });

  it("ignores a file that is not it", () => {
    expect(parseUpdateLater("")).toBeNull();
    expect(parseUpdateLater("[]")).toBeNull();
    expect(parseUpdateLater('{"version":"latest","notBefore":"2026-10-10T18:00:00Z"}')).toBeNull();
    expect(parseUpdateLater('{"version":"0.0.120","notBefore":"tonight"}')).toBeNull();
    expect(
      parseUpdateLater('{"version":"0.0.120","notBefore":"2026-10-10T20:00:00+02:00"}'),
    ).toEqual({ version: "0.0.120", notBefore: "2026-10-10T18:00:00.000Z" });
  });

  it("keeps the browser's time within reason: not in the past, at most a day ahead", () => {
    expect(clampNotBefore(iso(NOW + 3_600_000), NOW)).toBe(iso(NOW + 3_600_000));
    // Already past 20:00 → now.
    expect(clampNotBefore(iso(NOW - 3_600_000), NOW)).toBe(iso(NOW));
    expect(clampNotBefore(iso(NOW + 30 * 86_400_000), NOW)).toBe(
      iso(NOW + UPDATE_LATER_MAX_AHEAD_MS),
    );
    expect(clampNotBefore("this evening", NOW)).toBeNull();
    expect(clampNotBefore(undefined, NOW)).toBeNull();
    expect(clampNotBefore(NOW, NOW)).toBeNull();
  });
});

describe("economy signals: wake a sleeping computer for it, hold it for the last minutes", () => {
  const later = { version: "0.0.120", notBefore: new Date(NOW + 3_600_000).toISOString() };

  it("nothing without the owner's word", () => {
    expect(economySignalsFor(null, null, NOW)).toEqual({ wakeAt: null, holdAwake: false });
  });

  it("the time ahead is an alarm for the console; a time that came is not", () => {
    expect(economySignalsFor(later, null, NOW)).toEqual({
      wakeAt: later.notBefore,
      holdAwake: false,
    });
    expect(economySignalsFor(later, { go: false, reason: "not-yet" }, NOW)).toEqual({
      wakeAt: later.notBefore,
      holdAwake: false,
    });
    expect(
      economySignalsFor({ ...later, notBefore: EVENING }, { go: false, reason: "busy" }, NOW),
    ).toEqual({ wakeAt: null, holdAwake: false });
  });

  it("holds the computer awake only while the quiet minutes are counted", () => {
    const due = { ...later, notBefore: EVENING };
    expect(economySignalsFor(due, { go: false, reason: "recent-activity" }, NOW).holdAwake).toBe(
      true,
    );
    for (const reason of ["busy", "reminder-soon", "in-progress", "no-release"] as const) {
      expect(economySignalsFor(due, { go: false, reason }, NOW).holdAwake).toBe(false);
    }
    expect(economySignalsFor(due, { go: true, version: "0.0.120" }, NOW).holdAwake).toBe(false);
  });

  it("nothing once the word is over", () => {
    for (const reason of ["current", "rolled-back"] as const) {
      expect(economySignalsFor(later, { go: false, reason }, NOW)).toEqual({
        wakeAt: null,
        holdAwake: false,
      });
    }
  });
});

function status(patch: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus {
  return {
    supported: true,
    canUpdate: true,
    currentVersion: "0.0.119",
    latestVersion: "0.0.120",
    available: true,
    state: "idle",
    step: null,
    error: null,
    fromVersion: null,
    toVersion: null,
    rolledBack: false,
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

describe("statusWithLater: what the app is told", () => {
  const stored = { version: "0.0.120", notBefore: EVENING };

  it("offers 'This evening' to the owner when an update is out", () => {
    expect(statusWithLater(status(), null)).toMatchObject({ later: null, laterAvailable: true });
    expect(statusWithLater(status({ canUpdate: false }), null).laterAvailable).toBe(false);
    expect(statusWithLater(status({ available: false }), null).laterAvailable).toBe(false);
    expect(statusWithLater(status({ supported: false }), null).laterAvailable).toBe(false);
  });

  it("shows the owner's word while it stands", () => {
    expect(statusWithLater(status(), stored).later).toEqual(stored);
    // Latest moved on: the word still stands.
    expect(statusWithLater(status({ latestVersion: "0.0.121" }), stored).later).toEqual(stored);
  });

  it("drops a word that has nothing left to say", () => {
    // The computer is on that version already.
    expect(
      statusWithLater(status({ currentVersion: "0.0.120", available: false }), stored).later,
    ).toBeNull();
    // The release was withdrawn.
    expect(
      statusWithLater(status({ latestVersion: "0.0.119", available: false }), stored).later,
    ).toBeNull();
    expect(statusWithLater(status({ supported: false }), stored).later).toBeNull();
  });

  it("does not offer or promise a version that was put back here", () => {
    const rolled = status({ state: "failed", rolledBack: true, toVersion: "0.0.120" });
    expect(statusWithLater(rolled, stored)).toMatchObject({ later: null, laterAvailable: false });
    // Put back from an older release: the new one is offered as usual.
    const older = status({ state: "failed", rolledBack: true, toVersion: "0.0.118" });
    expect(statusWithLater(older, stored)).toMatchObject({ later: stored, laterAvailable: true });
  });
});

describe("the daemon's own request (controller)", () => {
  it("drops the same file as the Update button; inProgress sees it and a running updater", async () => {
    const root = mkdtempSync(join(tmpdir(), "uno-update-later-"));
    mkdirSync(join(root, "status"));
    const statusFile = join(root, "status", "status.json");
    const requestFile = join(root, "ask", "request");
    // Real clock: the request's age comes from the file's mtime.
    const controller = makeSelfUpdateController({
      paths: { requestFile, statusFile, baseUrl: "https://x.test" },
      currentVersion: "0.0.119",
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    expect(controller.supported).toBe(true);
    expect(await controller.inProgress()).toBe(false);
    await controller.request();
    expect(existsSync(requestFile)).toBe(true);
    // Nothing the updater could read as input: a timestamp.
    expect(readFileSync(requestFile, "utf8").trim()).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await controller.inProgress()).toBe(true);
    // The app sees it like a pressed button: starting.
    expect((await controller.status({ canUpdate: true })).state).toBe("updating");

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

  it("does nothing on a computer without self-update", async () => {
    const none = makeSelfUpdateController({ paths: null, currentVersion: "0.0.119" });
    expect(none.supported).toBe(false);
    expect(await none.latest()).toBeNull();
    expect(await none.inProgress()).toBe(false);
    await expect(none.request()).rejects.toThrow();
  });
});
