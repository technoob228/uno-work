import { describe, expect, it } from "vitest";

import {
  type LiveHarnessSession,
  resolveHarnessBudget,
  selectSessionsToEvict,
} from "./harnessBudget.ts";

const GIB = 1024 ** 3;

describe("resolveHarnessBudget", () => {
  it("is strict on a 2 GB Work computer", () => {
    const budget = resolveHarnessBudget({ totalMemoryBytes: 2 * GIB, env: {} });
    expect(budget.inactivityThresholdMs).toBe(5 * 60_000);
    expect(budget.sweepIntervalMs).toBe(60_000);
    expect(budget.maxLiveProcesses).toBe(3);
    expect(budget.shareOpenCodeServer).toBe(true);
  });

  it("treats exactly 4 GB as small and anything above as roomy", () => {
    expect(resolveHarnessBudget({ totalMemoryBytes: 4 * GIB, env: {} }).maxLiveProcesses).toBe(3);
    const roomy = resolveHarnessBudget({ totalMemoryBytes: 16 * GIB, env: {} });
    expect(roomy.inactivityThresholdMs).toBe(15 * 60_000);
    expect(roomy.sweepIntervalMs).toBe(3 * 60_000);
    expect(roomy.maxLiveProcesses).toBeNull();
  });

  it("honours overrides from the environment", () => {
    const budget = resolveHarnessBudget({
      totalMemoryBytes: 2 * GIB,
      env: {
        UNO_WORK_HARNESS_IDLE_MINUTES: "0.25",
        UNO_WORK_MAX_LIVE_HARNESSES: "0",
        UNO_WORK_OPENCODE_SHARED_SERVER: "0",
      },
    });
    expect(budget.inactivityThresholdMs).toBe(15_000);
    expect(budget.sweepIntervalMs).toBe(30_000);
    expect(budget.maxLiveProcesses).toBeNull();
    expect(budget.shareOpenCodeServer).toBe(false);

    const capped = resolveHarnessBudget({
      totalMemoryBytes: 64 * GIB,
      env: { UNO_WORK_MAX_LIVE_HARNESSES: "5", UNO_WORK_HARNESS_IDLE_MINUTES: "nope" },
    });
    expect(capped.maxLiveProcesses).toBe(5);
    expect(capped.inactivityThresholdMs).toBe(15 * 60_000);
  });
});

const session = (
  threadId: string,
  lastActivityMs: number,
  overrides: Partial<LiveHarnessSession> = {},
): LiveHarnessSession => ({
  threadId,
  instanceId: "codex",
  sharesProcess: false,
  busy: false,
  lastActivityMs,
  ...overrides,
});

describe("selectSessionsToEvict", () => {
  it("evicts nothing under the cap", () => {
    expect(
      selectSessionsToEvict({
        live: [session("a", 1), session("b", 2)],
        incoming: { threadId: "c", instanceId: "codex", sharesProcess: false },
        maxLive: 3,
      }),
    ).toEqual([]);
  });

  it("evicts the least recently used idle session, never a busy one", () => {
    expect(
      selectSessionsToEvict({
        live: [session("busy-old", 1, { busy: true }), session("idle", 5), session("newer", 9)],
        incoming: { threadId: "d", instanceId: "codex", sharesProcess: false },
        maxLive: 3,
      }),
    ).toEqual(["idle"]);
  });

  it("exceeds the cap rather than stopping a running turn", () => {
    expect(
      selectSessionsToEvict({
        live: [
          session("a", 1, { busy: true }),
          session("b", 2, { busy: true }),
          session("c", 3, { busy: true }),
        ],
        incoming: { threadId: "d", instanceId: "codex", sharesProcess: false },
        maxLive: 3,
      }),
    ).toEqual([]);
  });

  it("counts a shared server once and a new thread on it as free", () => {
    const shared = (threadId: string, at: number) =>
      session(threadId, at, { instanceId: "uno", sharesProcess: true });
    const live = [shared("u1", 1), shared("u2", 2), shared("u3", 3), session("codex", 4)];
    expect(
      selectSessionsToEvict({
        live,
        incoming: { threadId: "u4", instanceId: "uno", sharesProcess: true },
        maxLive: 2,
      }),
    ).toEqual([]);
    // A third process (a new Claude thread) pushes out the idle Codex one —
    // stopping one uno thread would free nothing.
    expect(
      selectSessionsToEvict({
        live,
        incoming: { threadId: "claude", instanceId: "claudeAgent", sharesProcess: false },
        maxLive: 2,
      }),
    ).toEqual(["codex"]);
  });

  it("does not count the restarting thread's own session", () => {
    expect(
      selectSessionsToEvict({
        live: [session("a", 1), session("b", 2), session("c", 3)],
        incoming: { threadId: "c", instanceId: "codex", sharesProcess: false },
        maxLive: 3,
      }),
    ).toEqual([]);
  });
});
