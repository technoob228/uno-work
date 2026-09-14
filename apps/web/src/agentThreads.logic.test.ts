import { describe, expect, it } from "vitest";

import {
  describeAgentSentMessage,
  describeSpawnedThreadOrigin,
  normalizeThreadController,
  resolveThreadControlBarState,
} from "./agentThreads.logic";

describe("normalizeThreadController", () => {
  it("treats absent as human", () => {
    expect(normalizeThreadController(undefined)).toBe("human");
    expect(normalizeThreadController(null)).toBe("human");
    expect(normalizeThreadController("human")).toBe("human");
    expect(normalizeThreadController("agent")).toBe("agent");
  });
});

describe("describeSpawnedThreadOrigin", () => {
  it("names the parent when known", () => {
    expect(describeSpawnedThreadOrigin("Refactor auth")).toBe(
      "Created by the agent in “Refactor auth”",
    );
  });

  it("falls back when the parent is missing or blank", () => {
    expect(describeSpawnedThreadOrigin(null)).toBe("Created by an agent");
    expect(describeSpawnedThreadOrigin("   ")).toBe("Created by an agent");
  });
});

describe("describeAgentSentMessage", () => {
  it("names the sender thread when known", () => {
    expect(describeAgentSentMessage("Planner")).toBe("From the agent in “Planner”");
    expect(describeAgentSentMessage(undefined)).toBe("From an agent");
  });
});

describe("resolveThreadControlBarState", () => {
  it("returns null for threads a human created", () => {
    expect(
      resolveThreadControlBarState({
        spawnedByThreadId: null,
        controller: "agent",
        parentTitle: "Parent",
      }),
    ).toBeNull();
  });

  it("offers Take over while the agent drives", () => {
    const state = resolveThreadControlBarState({
      spawnedByThreadId: "parent-1",
      controller: "agent",
      parentTitle: "Parent",
    });
    expect(state).toMatchObject({
      controller: "agent",
      leadText: "An agent from ",
      parentLinkText: "“Parent”",
      trailText: " is driving this chat",
      actionLabel: "Take over",
      nextController: "human",
    });
  });

  it("offers Hand back to agent once the human is in control (absent = human)", () => {
    const state = resolveThreadControlBarState({
      spawnedByThreadId: "parent-1",
      controller: undefined,
      parentTitle: "Parent",
    });
    expect(state).toMatchObject({
      controller: "human",
      parentLinkText: "“Parent”",
      actionLabel: "Hand back to agent",
      nextController: "agent",
    });
    expect(state?.leadText.startsWith("You're in control")).toBe(true);
  });

  it("drops the link when the parent is not loaded", () => {
    const agent = resolveThreadControlBarState({
      spawnedByThreadId: "parent-1",
      controller: "agent",
      parentTitle: null,
    });
    expect(agent?.parentLinkText).toBeNull();
    expect(agent?.summary).toBe("An agent is driving this chat");

    const human = resolveThreadControlBarState({
      spawnedByThreadId: "parent-1",
      controller: "human",
      parentTitle: null,
    });
    expect(human?.parentLinkText).toBeNull();
    expect(human?.trailText).toBe("You're in control · started by an agent");
  });
});
