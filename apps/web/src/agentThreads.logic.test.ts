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

describe("resolveThreadControlBarState (0.0.115: Don't let agents write here)", () => {
  const base = { supportsAgentsAccess: true, agentsClosedAt: null } as const;

  it("shows nothing for an open chat a human created", () => {
    expect(
      resolveThreadControlBarState({
        ...base,
        spawnedByThreadId: null,
        controller: "agent",
        parentTitle: "Parent",
      }),
    ).toBeNull();
  });

  it("offers to close a chat the agent drives, with no Take over", () => {
    const state = resolveThreadControlBarState({
      ...base,
      spawnedByThreadId: "parent-1",
      controller: "agent",
      parentTitle: "Parent",
    });
    expect(state).toMatchObject({
      controller: "agent",
      closedToAgents: false,
      leadText: "An agent from ",
      parentLinkText: "“Parent”",
      trailText: " is driving this chat",
      action: { kind: "agents-access", label: "Don't let agents write here", nextClosed: true },
    });
  });

  it("never offers Hand back to agent for an old chat the person took over", () => {
    const state = resolveThreadControlBarState({
      ...base,
      spawnedByThreadId: "parent-1",
      controller: undefined,
      parentTitle: "Parent",
    });
    expect(state).toMatchObject({
      controller: "human",
      leadText: "Started by the agent in ",
      parentLinkText: "“Parent”",
      action: { kind: "agents-access", nextClosed: true },
    });
    expect(state?.summary).toBe("Started by the agent in “Parent”");
    expect(JSON.stringify(state)).not.toMatch(/Hand back/);
  });

  it("shows a closed chat, whoever created it, with the way to open it again", () => {
    const own = resolveThreadControlBarState({
      ...base,
      agentsClosedAt: "2026-10-08T12:00:00.000Z",
      spawnedByThreadId: null,
      controller: undefined,
      parentTitle: null,
    });
    expect(own).toMatchObject({
      closedToAgents: true,
      parentLinkText: null,
      summary: "Agents can't write here",
      action: { kind: "agents-access", label: "Let agents write here", nextClosed: false },
    });
    const spawned = resolveThreadControlBarState({
      ...base,
      agentsClosedAt: "2026-10-08T12:00:00.000Z",
      spawnedByThreadId: "parent-1",
      controller: "agent",
      parentTitle: "Parent",
    });
    expect(spawned?.summary).toBe("Agents can't write here · started by the agent in “Parent”");
    expect(spawned?.action).toMatchObject({ nextClosed: false });
  });

  it("drops the link when the parent is not loaded", () => {
    const agent = resolveThreadControlBarState({
      ...base,
      spawnedByThreadId: "parent-1",
      controller: "agent",
      parentTitle: null,
    });
    expect(agent?.parentLinkText).toBeNull();
    expect(agent?.summary).toBe("An agent is driving this chat");
    const human = resolveThreadControlBarState({
      ...base,
      spawnedByThreadId: "parent-1",
      controller: "human",
      parentTitle: null,
    });
    expect(human?.trailText).toBe("Started by an agent");
  });

  it("keeps the old handoff on an older daemon, so no chat stays locked there", () => {
    const human = resolveThreadControlBarState({
      spawnedByThreadId: "parent-1",
      controller: "human",
      parentTitle: "Parent",
    });
    expect(human?.action).toEqual({
      kind: "handoff",
      label: "Hand back to agent",
      nextController: "agent",
    });
    expect(
      resolveThreadControlBarState({
        spawnedByThreadId: null,
        controller: "human",
        parentTitle: null,
        agentsClosedAt: "2026-10-08T12:00:00.000Z",
      }),
    ).toBeNull();
  });
});
