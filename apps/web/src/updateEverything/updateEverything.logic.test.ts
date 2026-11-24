import type { AgentUpdateStatus } from "@t3tools/shared/agentVersions";
import { describe, expect, it } from "vitest";

import type { SelfUpdateStatus } from "../selfUpdate/selfUpdate";
import {
  buildUpdatePlan,
  isRecentlyUsed,
  isSelectedByDefault,
  isUpdatableBox,
  planRowLine,
  planCount,
  planRowSummary,
  planStoppedChats,
  planWaitableAgents,
  runUpdatePlan,
  type PlanRow,
  type RowProgress,
  type RunDeps,
  type UpdateTarget,
} from "./updateEverything.logic";

const self = (input: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({
  supported: true,
  canUpdate: true,
  currentVersion: "0.0.168",
  latestVersion: "0.0.170",
  available: true,
  state: "idle",
  step: null,
  error: null,
  fromVersion: null,
  toVersion: null,
  rolledBack: false,
  startedAt: null,
  finishedAt: null,
  ...input,
});

const agent = (input: Partial<AgentUpdateStatus>): AgentUpdateStatus => ({
  driver: "claudeAgent",
  name: "Claude",
  version: "2.1.284",
  target: "2.1.300",
  behind: true,
  managed: true,
  ...input,
});

const target = (input: Partial<UpdateTarget>): UpdateTarget => ({
  key: "a",
  label: "Work box",
  environmentId: "env-a",
  boxId: 1,
  isPrimary: false,
  reach: "online",
  selfUpdate: null,
  agents: null,
  runningChats: 0,
  ...input,
});

describe("buildUpdatePlan", () => {
  it("lists what each computer needs", () => {
    const [row] = buildUpdatePlan([
      target({
        selfUpdate: self({}),
        agents: [agent({}), agent({ driver: "codex", name: "Codex", behind: false })],
      }),
    ]);
    expect(row).toMatchObject({ work: "0.0.170", skipped: null });
    expect(row?.agents.map((entry) => entry.name)).toEqual(["Claude"]);
    expect(planRowSummary(row!)).toBe("Uno Work 0.0.170 · Claude 2.1.300");
  });

  it("wakes a sleeping box, skips what can't be reached", () => {
    const rows = buildUpdatePlan([
      target({ key: "asleep", reach: "asleep" }),
      target({ key: "gone", reach: "offline" }),
    ]);
    expect(rows[0]).toMatchObject({ wakes: true, skipped: null });
    expect(rows[1]).toMatchObject({ wakes: false, skipped: "Offline" });
    expect(planCount(rows)).toBe(1);
  });

  it("says so when only the owner can update", () => {
    const [row] = buildUpdatePlan([target({ selfUpdate: self({ canUpdate: false }) })]);
    expect(row).toMatchObject({ work: null, skipped: "Only its owner can update it" });
  });

  it("calls a current computer up to date", () => {
    const rows = buildUpdatePlan([target({ selfUpdate: self({ available: false }), agents: [] })]);
    expect(planRowSummary(rows[0]!)).toBe("Up to date");
    expect(planCount(rows)).toBe(0);
  });

  it("puts the computer serving this page last", () => {
    const rows = buildUpdatePlan([
      target({ key: "here", isPrimary: true }),
      target({ key: "there" }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["there", "here"]);
  });

  it("counts only the chats a Work restart stops", () => {
    const rows = buildUpdatePlan([
      target({ key: "a", selfUpdate: self({}), runningChats: 2 }),
      target({ key: "b", agents: [agent({})], runningChats: 5 }),
    ]);
    expect(planStoppedChats(rows)).toBe(2);
  });
});

describe("waiting for the agents", () => {
  it("counts only agents a computer can hold the update for", () => {
    const rows = buildUpdatePlan([
      // Counts its agents itself.
      target({ key: "new", selfUpdate: self({ workingAgents: 2 }), runningChats: 2 }),
      // Before "Update when they finish": it restarts at once whatever it is asked.
      target({ key: "old", selfUpdate: self({}), runningChats: 1 }),
      // Nothing to update: its agents aren't in the way.
      target({ key: "fresh", selfUpdate: self({ available: false, workingAgents: 3 }) }),
    ]);
    expect(planWaitableAgents(rows)).toBe(2);
    expect(planStoppedChats(rows)).toBe(3);
  });
});

describe("runUpdatePlan", () => {
  const recorder = () => {
    const calls: string[] = [];
    const last = new Map<string, RowProgress>();
    const deps: RunDeps = {
      wake: async (row) => {
        calls.push(`wake:${row.key}`);
        return { environmentId: `env-${row.key}`, work: "0.0.170", agents: [] };
      },
      updateAgent: async (environmentId, entry) => {
        calls.push(`agent:${environmentId}:${entry.name}`);
      },
      updateWork: async (environmentId) => {
        calls.push(`work:${environmentId}`);
        return "updated";
      },
      onProgress: (key, progress) => last.set(key, progress),
    };
    return { calls, last, deps };
  };

  const plan = (input: ReadonlyArray<Partial<UpdateTarget>>): ReadonlyArray<PlanRow> =>
    buildUpdatePlan(input.map(target));

  it("leaves a computer holding the update for its agents to finish by itself", async () => {
    const { last, deps } = recorder();
    await runUpdatePlan(plan([{ selfUpdate: self({ workingAgents: 1 }) }]), {
      ...deps,
      updateWork: async () => "waiting",
    });
    expect(last.get("a")).toEqual({ kind: "held", note: "Updates when its agents finish" });
  });

  it("updates the agents before Work on one computer", async () => {
    const { calls, last, deps } = recorder();
    await runUpdatePlan(plan([{ selfUpdate: self({}), agents: [agent({})] }]), deps);
    expect(calls).toEqual(["agent:env-a:Claude", "work:env-a"]);
    expect(last.get("a")).toEqual({ kind: "done", note: "Updated to Uno Work 0.0.170" });
  });

  it("finishes the other computers before the one serving this page", async () => {
    const { calls, deps } = recorder();
    await runUpdatePlan(
      plan([
        { key: "here", environmentId: "here", isPrimary: true, selfUpdate: self({}) },
        { key: "there", environmentId: "there", selfUpdate: self({}) },
      ]),
      deps,
    );
    expect(calls).toEqual(["work:there", "work:here"]);
  });

  it("wakes a sleeping computer and updates it by what it says then", async () => {
    const { calls, last, deps } = recorder();
    await runUpdatePlan(plan([{ key: "z", environmentId: null, reach: "asleep" }]), deps);
    expect(calls).toEqual(["wake:z", "work:env-z"]);
    expect(last.get("z")).toEqual({ kind: "done", note: "Updated to Uno Work 0.0.170" });
  });

  it("goes on after an agent fails, and says what failed", async () => {
    const { calls, last, deps } = recorder();
    const failing: RunDeps = {
      ...deps,
      updateAgent: async () => {
        throw new Error("npm couldn't reach the registry.");
      },
    };
    await runUpdatePlan(plan([{ selfUpdate: self({}), agents: [agent({})] }]), failing);
    expect(calls).toEqual(["work:env-a"]);
    expect(last.get("a")).toEqual({
      kind: "failed",
      message: "Claude: npm couldn't reach the registry.",
    });
  });

  it("keeps one failed computer from stopping the rest", async () => {
    const { last, deps } = recorder();
    const failing: RunDeps = {
      ...deps,
      wake: async () => {
        throw new Error("Still starting.");
      },
    };
    await runUpdatePlan(
      plan([
        { key: "a", environmentId: null, reach: "asleep" },
        { key: "b", environmentId: "b", selfUpdate: self({}) },
      ]),
      failing,
    );
    expect(last.get("a")).toEqual({ kind: "failed", message: "Still starting." });
    expect(last.get("b")).toEqual({ kind: "done", note: "Updated to Uno Work 0.0.170" });
  });
});

describe("which computers the list offers (24.11: a list of 20, nothing updated)", () => {
  it("leaves archived boxes and plain servers out", () => {
    expect(isUpdatableBox({ status: "archived" })).toBe(false);
    expect(isUpdatableBox({ status: "deleting" })).toBe(false);
    expect(isUpdatableBox({ status: "running", workMachine: false })).toBe(false);
    expect(isUpdatableBox({ status: "sleeping", workMachine: true })).toBe(true);
    // An older console doesn't say: a running or sleeping box stays in.
    expect(isUpdatableBox({ status: "running" })).toBe(true);
  });

  it("ticks only computers that are on and need an update", () => {
    const rows = buildUpdatePlan([
      target({ key: "on", selfUpdate: self({}) }),
      target({ key: "asleep", environmentId: null, reach: "asleep" }),
      target({ key: "current", selfUpdate: self({ available: false }), agents: [] }),
    ]);
    const ticked = rows.filter(isSelectedByDefault).map((row) => row.key);
    expect(ticked).toEqual(["on"]);
  });

  it("says plainly what happens to a sleeping computer", () => {
    const [row] = buildUpdatePlan([target({ environmentId: null, reach: "asleep" })]);
    expect(planRowLine(row!, false)).toBe(
      "Not open here now. Its own Update shows when you open it",
    );
    expect(planRowLine(row!, true)).toBe("Not open here now. Wakes up or connects to update");
  });
});

describe("runUpdatePlan never hangs as a whole", () => {
  const never = <T>() => new Promise<T>(() => {});
  const base = (calls: string[], last: Map<string, RowProgress>): RunDeps => ({
    wake: async (row) => ({ environmentId: `env-${row.key}`, work: "0.0.170", agents: [] }),
    updateAgent: async () => {},
    updateWork: async (environmentId) => {
      calls.push(`work:${environmentId}`);
      return "updated";
    },
    onProgress: (key, progress) => last.set(key, progress),
  });
  const fast = { wakeMs: 30, agentMs: 30, workMs: 30, versionMs: 30 };

  it("reaches this computer even when every other one never wakes", async () => {
    const calls: string[] = [];
    const last = new Map<string, RowProgress>();
    const rows = buildUpdatePlan([
      target({ key: "here", environmentId: "here", isPrimary: true, selfUpdate: self({}) }),
      ...Array.from({ length: 19 }, (_, index) =>
        target({ key: `asleep-${index}`, environmentId: null, reach: "asleep" }),
      ),
    ]);
    await runUpdatePlan(rows, { ...base(calls, last), wake: () => never() }, fast);
    expect(calls).toEqual(["work:here"]);
    expect(last.get("asleep-0")).toEqual({
      kind: "failed",
      message: "Didn't wake up in 1 min. Update it when you open it.",
    });
    expect(last.get("here")?.kind).toBe("done");
  });

  it("runs at most three computers at a time", async () => {
    let running = 0;
    let peak = 0;
    const last = new Map<string, RowProgress>();
    const rows = buildUpdatePlan(
      Array.from({ length: 8 }, (_, index) =>
        target({ key: `c${index}`, environmentId: `c${index}`, selfUpdate: self({}) }),
      ),
    );
    await runUpdatePlan(rows, {
      ...base([], last),
      updateWork: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return "updated";
      },
    });
    expect(peak).toBe(3);
    expect([...last.values()].every((progress) => progress.kind === "done")).toBe(true);
  });

  it("fails one computer whose update doesn't answer, and goes on", async () => {
    const calls: string[] = [];
    const last = new Map<string, RowProgress>();
    const rows = buildUpdatePlan([
      target({ key: "stuck", environmentId: "stuck", selfUpdate: self({}) }),
      target({ key: "fine", environmentId: "fine", selfUpdate: self({}) }),
    ]);
    await runUpdatePlan(
      rows,
      {
        ...base(calls, last),
        updateWork: async (environmentId) =>
          environmentId === "stuck" ? never() : ("updated" as const),
      },
      { ...fast, concurrency: 1 },
    );
    expect(last.get("stuck")).toEqual({
      kind: "failed",
      message: "Uno Work: no answer in 1 min. It may still finish by itself.",
    });
    expect(last.get("fine")?.kind).toBe("done");
  });
});

describe("the result is what each computer reports", () => {
  const deps = (version: string | null, last: Map<string, RowProgress>): RunDeps => ({
    wake: async () => ({ environmentId: "x", work: null, agents: [] }),
    updateAgent: async () => {},
    updateWork: async () => "updated",
    readVersion: async () => version,
    onProgress: (key, progress) => last.set(key, progress),
  });
  const one = () => buildUpdatePlan([target({ selfUpdate: self({}) })]);

  it("shows the version the computer runs after the update", async () => {
    const last = new Map<string, RowProgress>();
    await runUpdatePlan(one(), deps("0.0.170", last));
    expect(last.get("a")).toEqual({ kind: "done", note: "Updated · Uno Work 0.0.170" });
  });

  it("doesn't call it updated when the computer is still on the old version", async () => {
    const last = new Map<string, RowProgress>();
    await runUpdatePlan(one(), deps("0.0.168", last));
    expect(last.get("a")).toEqual({
      kind: "failed",
      message: "Still on Uno Work 0.0.168. Try again in a minute.",
    });
  });

  it("counts a slow update that got there after all", async () => {
    const last = new Map<string, RowProgress>();
    await runUpdatePlan(
      one(),
      { ...deps("0.0.170", last), updateWork: () => new Promise(() => {}) },
      { workMs: 20 },
    );
    expect(last.get("a")).toEqual({ kind: "done", note: "Updated · Uno Work 0.0.170" });
  });
});

describe("computers not in use stay out of the way (Misha 24.11)", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  it("counts this computer, one on the line, and one used in the last two weeks", () => {
    expect(isRecentlyUsed(target({ isPrimary: true, reach: "asleep" }), now)).toBe(true);
    expect(isRecentlyUsed(target({ reach: "online" }), now)).toBe(true);
    expect(isRecentlyUsed(target({ reach: "asleep", lastUsedAt: daysAgo(3) }), now)).toBe(true);
    expect(isRecentlyUsed(target({ reach: "asleep", lastUsedAt: daysAgo(15) }), now)).toBe(false);
    // Never opened.
    expect(isRecentlyUsed(target({ reach: "asleep", lastUsedAt: null }), now)).toBe(false);
  });

  it("never ticks a computer that isn't in use", () => {
    const rows = buildUpdatePlan(
      [target({ key: "old", reach: "asleep", environmentId: null, lastUsedAt: daysAgo(40) })],
      now,
    );
    expect(rows[0]).toMatchObject({ recent: false, wakes: true });
    expect(isSelectedByDefault(rows[0]!)).toBe(false);
  });
});
