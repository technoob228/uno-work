import type { AgentUpdateStatus } from "@t3tools/shared/agentVersions";
import { describe, expect, it } from "vitest";

import type { SelfUpdateStatus } from "../selfUpdate/selfUpdate";
import {
  buildUpdatePlan,
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
    expect(last.get("a")).toEqual({ kind: "done", note: "Updated" });
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
    expect(last.get("z")).toEqual({ kind: "done", note: "Updated" });
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
    expect(last.get("b")).toEqual({ kind: "done", note: "Updated" });
  });
});
