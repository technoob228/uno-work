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
import {
  isAgentStartedChat,
  PERSON_RECENT_MS,
  threadOwner as threadOwnerAt,
  threadOwnerWithStarter as threadOwnerWithStarterAt,
  type ThreadOwnerInput,
} from "./Sidebar.owner";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const MINUTE_MS = 60 * 1_000;
const HOUR = 60;
const DAY = 24 * HOUR;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE_MS).toISOString();
const threadOwner = (thread: ThreadOwnerInput) => threadOwnerAt(thread, NOW);
const threadOwnerWithStarter = (thread: ThreadOwnerInput, startedByAssistant: boolean) =>
  threadOwnerWithStarterAt(thread, startedByAssistant, NOW);

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
  it("a chat the person started is theirs while the last word is theirs", () => {
    expect(threadOwner(agentChat({ startedBy: null, spawnedByThreadId: null }))).toBe("you");
    expect(
      threadOwner(
        agentChat({
          startedBy: null,
          spawnedByThreadId: null,
          latestPersonMessageAt: at(20),
          latestUserMessageAt: at(20),
        }),
      ),
    ).toBe("you");
  });

  it("the person's own chat stays theirs while agents talk in it (Misha 14.11)", () => {
    // Their coordinator: another chat's agent wrote last, nothing asks them.
    const talking = agentChat({
      startedBy: null,
      spawnedByThreadId: null,
      controller: "human",
      latestPersonMessageAt: at(60),
      latestUserMessageAt: at(20),
    });
    expect(threadOwner(talking)).toBe("you");
    expect(threadOwner({ ...talking, childWork: { working: 1, latestStartedAt: at(50) } })).toBe(
      "you",
    );
    expect(threadOwner({ ...talking, session: session("running") })).toBe("you");
    expect(threadOwner({ ...talking, startedBy: undefined })).toBe("you");
    // Only handing it to its agent takes it out of Only mine.
    expect(threadOwner({ ...talking, controller: "agent", controlChangedAt: at(30) })).toBe(
      "agent",
    );
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

  it("answers their automation's message until they Read or Done the answer", () => {
    // An automation of theirs wrote in an agent's chat they never joined: it
    // counts as their request (13.11), not as "they wrote here" (20.11).
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

  it("goes back to the agent when another agent wrote after their automation", () => {
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

describe("threadOwner: yours if you started it or wrote there recently (Misha 20.11)", () => {
  // An agent's chat the person wrote in: writing took it from the agent
  // (controller "human" since then). Agents wrote after them, and they read
  // the last answer: nothing else holds it for them.
  const wrote = (minutesAgo: number, overrides: Partial<SidebarThreadSummary> = {}) =>
    agentChat({
      controller: "human",
      controlChangedAt: at(minutesAgo),
      latestPersonMessageAt: at(minutesAgo),
      latestUserMessageAt: at(Math.min(minutesAgo, 20)),
      readAt: at(5),
      ...overrides,
    });

  it("an agent's chat they wrote in an hour ago is theirs", () => {
    expect(threadOwner(wrote(HOUR))).toBe("you");
    // Agents working in it right now don't take it either.
    expect(threadOwner(wrote(HOUR, { session: session("running") }))).toBe("you");
  });

  it("one they last wrote in three days ago is the agent's again", () => {
    expect(threadOwner(wrote(3 * DAY))).toBe("agent");
    // "Recently" is PERSON_RECENT_MS, a day.
    expect(PERSON_RECENT_MS).toBe(DAY * MINUTE_MS);
    expect(threadOwner(wrote(DAY - 1))).toBe("you");
    expect(threadOwner(wrote(DAY))).toBe("agent");
    // A later message of theirs counts, not the one that took it over.
    expect(threadOwner(wrote(3 * DAY, { latestPersonMessageAt: at(2 * HOUR) }))).toBe("you");
    // Still theirs while it needs them.
    expect(threadOwner(wrote(3 * DAY, { hasPendingUserInput: true }))).toBe("you");
    expect(threadOwner(wrote(3 * DAY, { personCalledAt: at(1) }))).toBe("you");
  });

  it("Join counts like a message: theirs for a day after it", () => {
    const joined = agentChat({ controller: "human", controlChangedAt: at(10), readAt: at(5) });
    expect(threadOwner(joined)).toBe("you");
    expect(threadOwner({ ...joined, controlChangedAt: at(3 * DAY) })).toBe("agent");
  });

  it("Hand to agent after their message makes it the agent's", () => {
    const handed = wrote(HOUR, { controller: "agent", controlChangedAt: at(30), readAt: null });
    expect(threadOwner(handed)).toBe("agent");
    // Even with the answer to their message unread.
    expect(threadOwner({ ...handed, unreadAnswerAt: at(40) })).toBe("agent");
    // Except while it needs them.
    expect(threadOwner({ ...handed, hasPendingApprovals: true })).toBe("you");
    expect(threadOwner({ ...handed, personCalledAt: at(10) })).toBe("you");
    // Writing there again takes it back.
    expect(
      threadOwner({
        ...handed,
        controller: "human",
        controlChangedAt: at(2),
        latestPersonMessageAt: at(2),
      }),
    ).toBe("you");
  });

  it("their automation's message in an agent's chat is not them writing there", () => {
    const automation = agentChat({
      latestPersonMessageAt: at(HOUR),
      latestUserMessageAt: at(20),
      readAt: at(5),
    });
    expect(threadOwner(automation)).toBe("agent");
  });

  it("a chat Uno started is theirs while they write there", () => {
    const uno = agentChat({
      spawnedByThreadId: null,
      startedBy: "assistant",
      controller: "human",
      latestPersonMessageAt: at(HOUR),
      latestUserMessageAt: at(20),
      readAt: at(5),
    });
    expect(threadOwner(uno)).toBe("you");
    expect(threadOwner({ ...uno, latestPersonMessageAt: at(3 * DAY) })).toBe("agent");
    // The sidebar knows Uno started it, the chat doesn't say so.
    const quiet = { ...uno, startedBy: null };
    expect(threadOwnerWithStarter(quiet, true)).toBe("you");
    expect(threadOwnerWithStarter({ ...quiet, latestPersonMessageAt: at(3 * DAY) }, true)).toBe(
      "agent",
    );
  });
});

describe("threadOwner: their coordinator is always theirs (Misha 20.11)", () => {
  const tasks = { working: 0, latestStartedAt: at(3 * DAY) };

  it("a chat they started that runs agents, however long agents talk in it", () => {
    const own = agentChat({
      startedBy: null,
      spawnedByThreadId: null,
      controller: "human",
      latestPersonMessageAt: at(3 * DAY),
      latestUserMessageAt: at(20),
      readAt: at(5),
      childWork: tasks,
    });
    expect(threadOwner(own)).toBe("you");
    expect(threadOwner({ ...own, childWork: { working: 2, latestStartedAt: at(30) } })).toBe("you");
    expect(threadOwner({ ...own, session: session("running") })).toBe("you");
  });

  it("an agent's chat they took over that runs agents of its own", () => {
    const lead = agentChat({
      controller: "human",
      controlChangedAt: at(4 * DAY),
      latestPersonMessageAt: at(3 * DAY),
      latestUserMessageAt: at(20),
      readAt: at(5),
      childWork: tasks,
    });
    expect(threadOwner(lead)).toBe("you");
    // Without tasks of its own it is a chat they left three days ago.
    expect(threadOwner({ ...lead, childWork: undefined })).toBe("agent");
    // An agent's coordinator they never joined is the agent's.
    expect(
      threadOwner({
        ...lead,
        controller: "agent",
        controlChangedAt: null,
        latestPersonMessageAt: null,
      }),
    ).toBe("agent");
    // Handed to its agent: the agent's.
    expect(threadOwner({ ...lead, controller: "agent", controlChangedAt: at(DAY) })).toBe("agent");
  });

  it("Uno's own chat is always theirs", () => {
    const unoChat = agentChat({
      startedBy: null,
      spawnedByThreadId: null,
      assistantRole: "chat",
      controller: "agent",
      controlChangedAt: at(DAY),
      childWork: tasks,
    });
    expect(threadOwner(unoChat)).toBe("you");
    expect(threadOwnerWithStarter(unoChat, true)).toBe("you");
  });
});

describe("threadOwnerWithStarter (Misha 29.10: assistants' chats under Only mine)", () => {
  // A chat the chat itself says nothing about, that the sidebar knows an assistant started.
  const quiet = agentChat({ startedBy: null, spawnedByThreadId: null });

  it("an assistant's chat working on its own is not the person's", () => {
    expect(threadOwner(quiet)).toBe("you");
    expect(threadOwnerWithStarter(quiet, true)).toBe("agent");
    expect(threadOwnerWithStarter(quiet, false)).toBe("you");
  });

  it("stays the person's while it waits for them", () => {
    expect(threadOwnerWithStarter({ ...quiet, hasPendingApprovals: true }, true)).toBe("you");
    expect(threadOwnerWithStarter({ ...quiet, personCalledAt: at(5) }, true)).toBe("you");
  });

  it("an older daemon (no startedBy): the chat is the person's once they took it over", () => {
    const old = { ...quiet, startedBy: undefined };
    expect(threadOwnerWithStarter(old, true)).toBe("agent");
    expect(threadOwnerWithStarter({ ...old, controller: "human" as const }, true)).toBe("you");
  });

  it("a chat the person handed to its agent is the agent's until it needs them (14.11)", () => {
    const handed = agentChat({
      startedBy: null,
      spawnedByThreadId: null,
      controller: "agent",
      controlChangedAt: at(5),
      latestPersonMessageAt: at(20),
    });
    expect(threadOwner(handed)).toBe("agent");
    expect(threadOwner({ ...handed, hasPendingApprovals: true })).toBe("you");
    expect(threadOwner({ ...handed, personCalledAt: at(1) })).toBe("you");
    // Taken back (Join, or a message there): the person's again.
    expect(threadOwner({ ...handed, controller: "human" })).toBe("you");
  });

  it("the Uno chat itself is never hidden", () => {
    expect(threadOwnerWithStarter({ ...quiet, assistantRole: "chat" }, true)).toBe("you");
  });
});
