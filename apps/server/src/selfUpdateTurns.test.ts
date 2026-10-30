import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { UpdaterStatus } from "./selfUpdate.ts";
import {
  DEFERRED_UPDATE_IDLE_MS,
  DEFERRED_UPDATE_MAX_WAIT_MS,
  clearDeferredUpdate,
  clearTurnsSnapshot,
  decideDeferredUpdate,
  deferredUpdateFor,
  isSelfUpdateRestart,
  readContinuedThreads,
  readDeferredUpdate,
  readTurnsSnapshot,
  shouldKeepSnapshot,
  threadsToContinue,
  workingTurnsOf,
  writeContinuedThreads,
  writeDeferredUpdate,
  writeTurnsSnapshot,
  type TurnThreadView,
} from "./selfUpdateTurns.ts";

const T0 = Date.parse("2026-10-29T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const thread = (
  id: string,
  session: TurnThreadView["session"],
  latestTurn: TurnThreadView["latestTurn"] = null,
  extra: Partial<TurnThreadView> = {},
): TurnThreadView => ({ id, archivedAt: null, deletedAt: null, session, latestTurn, ...extra });

const running = (turnId: string | null) => ({ status: "running", activeTurnId: turnId });
const stopped = (status = "error") => ({ status, activeTurnId: null });

const run = (patch: Partial<UpdaterStatus>): UpdaterStatus => ({
  state: "updating",
  step: "Starting Uno Work 0.0.164",
  error: null,
  fromVersion: "0.0.163",
  toVersion: "0.0.164",
  rolledBack: false,
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  ...patch,
});

describe("workingTurnsOf", () => {
  it("counts the chats whose agent works, with the running turn", () => {
    expect(
      workingTurnsOf([
        thread("a", running("turn-a")),
        thread("b", { status: "starting", activeTurnId: null }),
        // Between two automatic retries: "running" with no turn yet.
        thread("c", running(null), { turnId: "turn-c", state: "running", requestedAt: iso(T0) }),
        thread("d", { status: "ready", activeTurnId: "turn-d" }),
        thread("idle", { status: "ready", activeTurnId: null }),
        thread("failed", stopped()),
        thread("never", null),
        thread("deleted", running("turn-x"), null, { deletedAt: iso(T0) }),
      ]),
    ).toEqual([
      { threadId: "a", turnId: "turn-a" },
      { threadId: "b", turnId: null },
      { threadId: "c", turnId: "turn-c" },
      { threadId: "d", turnId: "turn-d" },
    ]);
  });
});

describe("Update when they finish", () => {
  const deferred = deferredUpdateFor(T0);

  it("waits at most half an hour", () => {
    expect(Date.parse(deferred.deadlineAt) - Date.parse(deferred.requestedAt)).toBe(
      DEFERRED_UPDATE_MAX_WAIT_MS,
    );
    expect(
      decideDeferredUpdate({ deferred, idleSince: null, now: T0 + DEFERRED_UPDATE_MAX_WAIT_MS }),
    ).toBe("start");
    expect(decideDeferredUpdate({ deferred, idleSince: null, now: T0 + 60_000 })).toBe("wait");
  });

  it("starts once no agent has worked for a moment, not between two turns", () => {
    expect(decideDeferredUpdate({ deferred, idleSince: T0, now: T0 + 1_000 })).toBe("wait");
    expect(
      decideDeferredUpdate({ deferred, idleSince: T0, now: T0 + DEFERRED_UPDATE_IDLE_MS }),
    ).toBe("start");
  });

  it("a broken deadline does not hold the update forever", () => {
    expect(
      decideDeferredUpdate({
        deferred: { requestedAt: iso(T0), deadlineAt: "soon" },
        idleSince: null,
        now: T0,
      }),
    ).toBe("start");
  });
});

describe("who keeps the snapshot", () => {
  it("the daemon the update will stop, not the one it started", () => {
    const processStartedAt = T0;
    expect(shouldKeepSnapshot({ inProgress: null, processStartedAt })).toBe(false);
    expect(
      shouldKeepSnapshot({
        inProgress: { phase: "requested", since: T0 + 5_000 },
        processStartedAt,
      }),
    ).toBe(true);
    expect(
      shouldKeepSnapshot({
        inProgress: { phase: "updating", since: T0 + 5_000 },
        processStartedAt,
      }),
    ).toBe(true);
    // The updater ran before this process: this is the new daemon.
    expect(
      shouldKeepSnapshot({
        inProgress: { phase: "updating", since: T0 - 30_000 },
        processStartedAt,
      }),
    ).toBe(false);
  });
});

describe("isSelfUpdateRestart", () => {
  const processStartedAt = T0;
  const snapshot = { takenAt: iso(T0 - 3_000), turns: [{ threadId: "a", turnId: "turn-a" }] };

  it("an update that started before this process, with the old daemon's snapshot", () => {
    for (const state of ["updating", "done", "failed"] as const) {
      expect(
        isSelfUpdateRestart({
          snapshot,
          updater: run({ state, startedAt: iso(T0 - 90_000) }),
          processStartedAt,
        }),
      ).toBe(true);
    }
  });

  it("not a crash, a manual restart, or an updater that installed nothing", () => {
    // No updater ever ran here.
    expect(isSelfUpdateRestart({ snapshot, updater: null, processStartedAt })).toBe(false);
    // The last run is from yesterday: this restart is something else.
    expect(
      isSelfUpdateRestart({
        snapshot,
        updater: run({ state: "done", startedAt: iso(T0 - 24 * 60 * 60_000) }),
        processStartedAt,
      }),
    ).toBe(false);
    // "Already on the latest version": nothing was restarted.
    expect(
      isSelfUpdateRestart({
        snapshot,
        updater: run({ state: "current", startedAt: iso(T0 - 90_000) }),
        processStartedAt,
      }),
    ).toBe(false);
    // A run that starts after us is the next update, not ours.
    expect(
      isSelfUpdateRestart({
        snapshot,
        updater: run({ startedAt: iso(T0 + 60_000) }),
        processStartedAt,
      }),
    ).toBe(false);
    // A snapshot from long before the run.
    expect(
      isSelfUpdateRestart({
        snapshot: { ...snapshot, takenAt: iso(T0 - 60 * 60_000) },
        updater: run({ startedAt: iso(T0 - 90_000) }),
        processStartedAt,
      }),
    ).toBe(false);
    expect(
      isSelfUpdateRestart({
        snapshot: null,
        updater: run({ startedAt: iso(T0 - 90_000) }),
        processStartedAt,
      }),
    ).toBe(false);
  });
});

const turn = (turnId: string, state: string, requestedAt = iso(T0 - 60_000)) => ({
  turnId,
  state,
  requestedAt,
});

describe("threadsToContinue", () => {
  const takenAt = iso(T0);

  it("continues the cut-off chats, once, and only those nobody went on with", () => {
    const snapshot = {
      takenAt,
      turns: [
        { threadId: "cut", turnId: "turn-cut" },
        { threadId: "cut", turnId: "turn-cut" },
        { threadId: "starting", turnId: null },
        { threadId: "finished", turnId: "turn-finished" },
        { threadId: "person-went-on", turnId: "turn-old" },
        { threadId: "runs-again", turnId: "turn-r" },
        { threadId: "archived", turnId: "turn-ar" },
        { threadId: "deleted", turnId: "turn-del" },
        { threadId: "done-before", turnId: "turn-db" },
        { threadId: "gone", turnId: "turn-gone" },
      ],
    };
    const threads = [
      thread("cut", stopped(), turn("turn-cut", "interrupted")),
      thread("starting", stopped(), null),
      // Finished right before the stop: nothing to continue.
      thread(
        "finished",
        { status: "ready", activeTurnId: null },
        turn("turn-finished", "completed"),
      ),
      // The person already wrote after the update.
      thread("person-went-on", stopped("ready"), turn("turn-new", "completed", iso(T0 + 60_000))),
      thread("runs-again", running("turn-r2"), turn("turn-r2", "running", iso(T0 + 5_000))),
      thread("archived", stopped(), turn("turn-ar", "interrupted"), { archivedAt: iso(T0) }),
      thread("deleted", stopped(), turn("turn-del", "interrupted"), { deletedAt: iso(T0) }),
      thread("done-before", stopped(), turn("turn-db", "interrupted")),
    ];
    expect(
      threadsToContinue({ snapshot, threads, alreadyContinued: new Set(["done-before"]) }),
    ).toEqual([
      { threadId: "cut", turnId: "turn-cut" },
      { threadId: "starting", turnId: null },
    ]);
  });
});

describe("state files", () => {
  it("round-trip and clear; a missing or broken file reads as nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "uno-self-update-turns-"));
    expect(await readDeferredUpdate(stateDir)).toBeNull();
    expect(await readTurnsSnapshot(stateDir)).toBeNull();

    const deferred = deferredUpdateFor(T0);
    await writeDeferredUpdate(stateDir, deferred);
    expect(await readDeferredUpdate(stateDir)).toEqual(deferred);
    await clearDeferredUpdate(stateDir);
    await clearDeferredUpdate(stateDir);
    expect(await readDeferredUpdate(stateDir)).toBeNull();

    await writeTurnsSnapshot(stateDir, [{ threadId: "a", turnId: null }], T0);
    expect(await readTurnsSnapshot(stateDir)).toEqual({
      takenAt: iso(T0),
      turns: [{ threadId: "a", turnId: null }],
    });
    await clearTurnsSnapshot(stateDir);
    expect(await readTurnsSnapshot(stateDir)).toBeNull();

    await writeContinuedThreads(stateDir, "run-1", new Set(["a", "b"]));
    expect([...(await readContinuedThreads(stateDir, "run-1"))]).toEqual(["a", "b"]);
    // Another update: nothing continued in it yet.
    expect((await readContinuedThreads(stateDir, "run-2")).size).toBe(0);
    // No temp files left behind.
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
