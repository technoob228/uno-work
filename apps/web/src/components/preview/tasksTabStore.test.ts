import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  dropThreadTasksSnapshot,
  putThreadTasksSnapshot,
  type ThreadTasksSnapshot,
} from "./tasksTabStore";

const snapshot: ThreadTasksSnapshot = {
  activePlan: null,
  proposedPlan: null,
  label: "Tasks",
  environmentId: "env-1" as EnvironmentId,
  markdownCwd: "/repo",
  workspaceRoot: "/repo",
};

describe("putThreadTasksSnapshot", () => {
  it("stores a snapshot per thread", () => {
    expect(putThreadTasksSnapshot({}, "t-1", snapshot)).toEqual({ "t-1": snapshot });
  });

  it("keeps the same state when nothing changed", () => {
    const states = { "t-1": snapshot };
    expect(putThreadTasksSnapshot(states, "t-1", { ...snapshot })).toBe(states);
  });

  it("replaces the snapshot when a field changes", () => {
    const states = { "t-1": snapshot };
    const next = putThreadTasksSnapshot(states, "t-1", { ...snapshot, label: "Plan" });
    expect(next).not.toBe(states);
    expect(next["t-1"]?.label).toBe("Plan");
  });
});

describe("dropThreadTasksSnapshot", () => {
  it("forgets only that thread", () => {
    const states = { "t-1": snapshot, "t-2": snapshot };
    expect(dropThreadTasksSnapshot(states, "t-1")).toEqual({ "t-2": snapshot });
  });

  it("is a no-op for an unknown thread", () => {
    const states = { "t-1": snapshot };
    expect(dropThreadTasksSnapshot(states, "t-9")).toBe(states);
  });
});
