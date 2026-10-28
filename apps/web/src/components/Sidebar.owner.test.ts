import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { isAgentStartedChat, threadOwner } from "./Sidebar.owner";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const MINUTE_MS = 60 * 1_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE_MS).toISOString();

function completedTurn(completedAt: string): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(`turn-${completedAt}`),
    state: "completed",
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
    assistantMessageId: null,
  };
}

function session(status: ThreadSession["status"]): ThreadSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status,
    createdAt: at(0),
    updatedAt: at(0),
    orchestrationStatus: status === "running" ? "running" : "ready",
  };
}

/** A chat another agent started; its last turn finished 10 minutes ago. */
function agentChat(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("chat"),
    environmentId: EnvironmentId.make("env-local"),
    projectId: ProjectId.make("project-1"),
    title: "chat",
    interactionMode: "default",
    session: session("ready"),
    createdAt: at(120),
    archivedAt: null,
    pinnedAt: null,
    latestTurn: completedTurn(at(10)),
    branch: null,
    worktreePath: null,
    latestUserMessageAt: at(20),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    spawnedByThreadId: ThreadId.make("parent"),
    controller: "agent",
    startedBy: "agent",
    latestPersonMessageAt: null,
    personCalledAt: null,
    ...overrides,
  };
}

describe("isAgentStartedChat", () => {
  it("is any chat an agent, Uno or an app started, not the Uno chat itself", () => {
    expect(isAgentStartedChat({ startedBy: null, spawnedByThreadId: null })).toBe(false);
    expect(isAgentStartedChat({ startedBy: "app" })).toBe(true);
    expect(isAgentStartedChat({ assistantRole: "spawned" })).toBe(true);
    expect(isAgentStartedChat({ spawnedByThreadId: ThreadId.make("parent") })).toBe(true);
    expect(isAgentStartedChat({ startedBy: "assistant", assistantRole: "chat" })).toBe(false);
  });
});

describe("threadOwner", () => {
  it("a chat the person started is always theirs", () => {
    expect(threadOwner(agentChat({ startedBy: null, spawnedByThreadId: null }))).toBe("you");
  });

  it("an agent's chat working on its own is the agent's", () => {
    expect(threadOwner(agentChat())).toBe("agent");
    expect(threadOwner(agentChat({ session: session("running") }))).toBe("agent");
  });

  it("is the person's while it asks them something", () => {
    expect(threadOwner(agentChat({ hasPendingApprovals: true }))).toBe("you");
    expect(threadOwner(agentChat({ hasPendingUserInput: true }))).toBe("you");
  });

  it("is the person's once an agent calls them in, until Read, Done or a reply", () => {
    const called = agentChat({ personCalledAt: at(5) });
    expect(threadOwner(called)).toBe("you");
    // Read before the call does not count.
    expect(threadOwner({ ...called, readAt: at(8) })).toBe("you");
    expect(threadOwner({ ...called, readAt: at(1) })).toBe("agent");
    expect(threadOwner({ ...called, settledOverride: "settled", settledAt: at(1) })).toBe("agent");
    // They wrote there: the answer to it is theirs until Read or Done.
    const replied = {
      ...called,
      latestPersonMessageAt: at(2),
      latestUserMessageAt: at(2),
      session: session("running"),
    };
    expect(threadOwner(replied)).toBe("you");
  });

  it("answers the person's own message until they Read or Done the answer", () => {
    const answered = agentChat({ latestPersonMessageAt: at(20), latestUserMessageAt: at(20) });
    expect(threadOwner(answered)).toBe("you");
    expect(threadOwner({ ...answered, readAt: at(5) })).toBe("agent");
    expect(threadOwner({ ...answered, settledOverride: "settled", settledAt: at(5) })).toBe(
      "agent",
    );
    // Read before the answer came in does not count.
    expect(threadOwner({ ...answered, readAt: at(15) })).toBe("you");
    // Still working on it.
    expect(threadOwner({ ...answered, readAt: at(5), session: session("running") })).toBe("you");
  });

  it("goes back to the agent when another agent wrote last", () => {
    expect(
      threadOwner(agentChat({ latestPersonMessageAt: at(60), latestUserMessageAt: at(20) })),
    ).toBe("agent");
  });

  it("falls back to who drives the chat on a server before 28.10", () => {
    const old = agentChat({ startedBy: undefined, latestPersonMessageAt: undefined });
    expect(threadOwner(old)).toBe("agent");
    expect(threadOwner({ ...old, controller: "human" })).toBe("you");
  });
});
