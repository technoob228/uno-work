import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  SNOOZED_UNTIL_OPENED,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { isThreadSettled, resolveSidebarThreadSection } from "./Sidebar.sections";
import {
  countChatsWaitingOnYou,
  isYourTurn,
  YOUR_TURN_SINCE,
  yourTurnKind,
} from "./Sidebar.yourTurn";

const NOW = "2026-10-20T12:00:00.000Z";
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

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
    createdAt: NOW,
    updatedAt: NOW,
    orchestrationStatus: status === "running" ? "running" : status === "error" ? "error" : "ready",
  };
}

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("chat"),
    environmentId: EnvironmentId.make("env-local"),
    projectId: ProjectId.make("project-1"),
    title: "chat",
    interactionMode: "default",
    session: session("ready"),
    createdAt: ago(10 * DAY_MS),
    archivedAt: null,
    pinnedAt: null,
    updatedAt: ago(HOUR_MS),
    latestTurn: completedTurn(ago(HOUR_MS)),
    branch: null,
    worktreePath: null,
    latestUserMessageAt: ago(HOUR_MS + MINUTE_MS),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    snoozedUntil: null,
    snoozedAt: null,
    ...overrides,
  };
}

describe("isYourTurn", () => {
  it("a finished chat waits on the person", () => {
    expect(isYourTurn(makeThread(), NOW)).toBe(true);
  });

  it("is not about having looked: there is no visited input at all", () => {
    // Opening the chat changes nothing the rule reads; only a reply or Done does.
    expect(isYourTurn({ ...makeThread(), lastVisitedAt: NOW } as SidebarThreadSummary, NOW)).toBe(
      true,
    );
  });

  it("ends when the person writes again", () => {
    expect(isYourTurn(makeThread({ latestUserMessageAt: ago(MINUTE_MS) }), NOW)).toBe(false);
  });

  it("ends with Read, and comes back when a later turn finishes", () => {
    expect(isYourTurn(makeThread({ readAt: ago(MINUTE_MS) }), NOW)).toBe(false);
    // The mark is older than the turn that finished last: it asks again.
    expect(isYourTurn(makeThread({ readAt: ago(9 * DAY_MS) }), NOW)).toBe(true);
    expect(isYourTurn(makeThread({ readAt: null }), NOW)).toBe(true);
  });

  it("ends with Done, and comes back when a later turn finishes", () => {
    const done = makeThread({ settledOverride: "settled", settledAt: ago(30 * MINUTE_MS) });
    expect(isYourTurn(done, NOW)).toBe(false);
    const finishedAfterDone = makeThread({
      settledOverride: "settled",
      settledAt: ago(2 * HOUR_MS),
    });
    expect(isYourTurn(finishedAfterDone, NOW)).toBe(true);
  });

  it("does not show while the chat works, asks or waits for an approval", () => {
    expect(isYourTurn(makeThread({ session: session("running") }), NOW)).toBe(false);
    expect(isYourTurn(makeThread({ hasPendingApprovals: true }), NOW)).toBe(false);
    expect(isYourTurn(makeThread({ hasPendingUserInput: true }), NOW)).toBe(false);
  });

  it("skips chats finished before the feature shipped", () => {
    const before = new Date(Date.parse(YOUR_TURN_SINCE) - MINUTE_MS).toISOString();
    expect(
      isYourTurn(
        makeThread({ latestTurn: completedTurn(before), latestUserMessageAt: before }),
        NOW,
      ),
    ).toBe(false);
  });

  it("skips assistant chats and chats another agent started", () => {
    expect(isYourTurn(makeThread({ projectId: ProjectId.make("assistant-home") }), NOW)).toBe(
      false,
    );
    expect(isYourTurn(makeThread({ spawnedByThreadId: ThreadId.make("parent") }), NOW)).toBe(false);
  });

  it("lights an agent's chat that called the person or answers them", () => {
    const agentChat = { startedBy: "agent" as const, spawnedByThreadId: ThreadId.make("parent") };
    // Called after the person had pressed Read: the call still counts.
    expect(
      isYourTurn(
        makeThread({ ...agentChat, readAt: ago(30 * MINUTE_MS), personCalledAt: ago(MINUTE_MS) }),
        NOW,
      ),
    ).toBe(true);
    // Answers the person's own message.
    expect(
      isYourTurn(
        makeThread({
          ...agentChat,
          latestPersonMessageAt: ago(HOUR_MS + MINUTE_MS),
          latestUserMessageAt: ago(HOUR_MS + MINUTE_MS),
        }),
        NOW,
      ),
    ).toBe(true);
    // An agent wrote the latest message: it reports back to that agent.
    expect(
      isYourTurn(
        makeThread({
          ...agentChat,
          latestPersonMessageAt: ago(DAY_MS),
          latestUserMessageAt: ago(HOUR_MS + MINUTE_MS),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("stays quiet while snoozed", () => {
    // Snoozed after the turn finished: nothing raised its hand since.
    expect(
      isYourTurn(makeThread({ snoozedUntil: ahead(HOUR_MS), snoozedAt: ago(MINUTE_MS) }), NOW),
    ).toBe(false);
  });
});

describe("Your turn in the sidebar sections", () => {
  it("never ages into the settled tail", () => {
    const waiting = makeThread({
      latestTurn: completedTurn(ago(10 * DAY_MS)),
      latestUserMessageAt: ago(10 * DAY_MS + MINUTE_MS),
    });
    expect(isThreadSettled(waiting, NOW)).toBe(false);
    expect(resolveSidebarThreadSection(waiting, NOW)).toBe("active");
  });

  it("an answered chat still ages out as before", () => {
    const answeredDone = makeThread({
      latestTurn: completedTurn(ago(10 * DAY_MS)),
      latestUserMessageAt: ago(10 * DAY_MS + MINUTE_MS),
      settledOverride: "settled",
      settledAt: ago(9 * DAY_MS),
    });
    expect(resolveSidebarThreadSection(answeredDone, NOW)).toBe("settled");
  });
});

describe("a chat imported from a computer", () => {
  const source = (lastActiveAt: string) => ({
    kind: "computer" as const,
    computerId: "c1",
    computerName: "MacBook",
    tool: "claude" as const,
    sessionId: "session-1",
    path: "~/.claude/projects/a/session-1.jsonl",
    cwd: "/Users/me/app",
    lastActiveAt,
  });
  const imported = (overrides: Partial<SidebarThreadSummary> = {}) =>
    makeThread({
      session: null,
      latestTurn: null,
      latestUserMessageAt: null,
      source: source(ago(HOUR_MS)),
      ...overrides,
    });

  it("is Ready: it finished where it was, on the computer", () => {
    expect(isYourTurn(imported(), NOW)).toBe(true);
    expect(resolveSidebarThreadSection(imported(), NOW)).toBe("active");
  });

  it("stops being Ready the usual way", () => {
    const settled = imported({ settledOverride: "settled", settledAt: ago(MINUTE_MS) });
    expect(isYourTurn(settled, NOW)).toBe(false);
  });

  it("stays on the shelf while snoozed until opened", () => {
    const shelved = imported({
      source: source(ago(3 * DAY_MS)),
      snoozedUntil: SNOOZED_UNTIL_OPENED,
      snoozedAt: ago(MINUTE_MS),
    });
    expect(resolveSidebarThreadSection(shelved, NOW)).toBe("snoozed");
  });

  it("doesn't add to the count of chats waiting on you", () => {
    expect(countChatsWaitingOnYou([imported(), makeThread()], NOW)).toBe(1);
  });
});

describe("countChatsWaitingOnYou", () => {
  it("counts approvals, questions and finished chats; not working, done or archived ones", () => {
    expect(
      countChatsWaitingOnYou(
        [
          makeThread(),
          makeThread({ hasPendingApprovals: true }),
          makeThread({ session: session("running") }),
          makeThread({ settledOverride: "settled", settledAt: ago(MINUTE_MS) }),
          makeThread({ archivedAt: ago(MINUTE_MS) }),
        ],
        NOW,
      ),
    ).toBe(2);
  });
});

describe("the person's own chat where agents talk (Misha 13.11)", () => {
  // A daemon from 28.10 on: it knows who wrote what (startedBy null = the person's chat).
  const mine = (overrides: Partial<SidebarThreadSummary> = {}) =>
    makeThread({ startedBy: null, ...overrides });
  const agentSpokeLast = {
    latestPersonMessageAt: ago(DAY_MS),
    latestUserMessageAt: ago(HOUR_MS + MINUTE_MS),
  };

  it("is Ready when the turn answered the person", () => {
    const answered = mine({
      latestPersonMessageAt: ago(HOUR_MS + MINUTE_MS),
      latestUserMessageAt: ago(HOUR_MS + MINUTE_MS),
    });
    expect(isYourTurn(answered, NOW)).toBe(true);
    expect(yourTurnKind(answered, NOW)).toBe("ready");
  });

  it("waits on agents when the turn answered another chat's agent: no Ready, no badge", () => {
    const talking = mine(agentSpokeLast);
    expect(isYourTurn(talking, NOW)).toBe(false);
    expect(countChatsWaitingOnYou([talking], NOW)).toBe(0);
  });

  it("is Needs you when an agent called the person in", () => {
    const called = mine({ ...agentSpokeLast, personCalledAt: ago(30 * MINUTE_MS) });
    expect(isYourTurn(called, NOW)).toBe(true);
    expect(yourTurnKind(called, NOW)).toBe("called");
    expect(countChatsWaitingOnYou([called], NOW)).toBe(1);
  });

  it("still shows an approval or a question", () => {
    expect(
      countChatsWaitingOnYou([mine({ ...agentSpokeLast, hasPendingApprovals: true })], NOW),
    ).toBe(1);
  });

  it("an older daemon, or no message of the person's on record: as before", () => {
    expect(isYourTurn(makeThread(agentSpokeLast), NOW)).toBe(true);
    expect(
      isYourTurn(mine({ latestPersonMessageAt: null, latestUserMessageAt: ago(2 * HOUR_MS) }), NOW),
    ).toBe(true);
  });

  it("safety net: Ready once the chats started for the request are all done", () => {
    const waited = (working: number, latestStartedAt: string) =>
      mine({ ...agentSpokeLast, childWork: { working, latestStartedAt } });
    // One still works: waiting.
    expect(isYourTurn(waited(1, ago(20 * HOUR_MS)), NOW)).toBe(false);
    // All done: the request is answered.
    expect(isYourTurn(waited(0, ago(20 * HOUR_MS)), NOW)).toBe(true);
    // Started before the person's latest message: not this request's.
    expect(isYourTurn(waited(0, ago(2 * DAY_MS)), NOW)).toBe(false);
    // Read after it finished: quiet until the next turn.
    expect(isYourTurn({ ...waited(0, ago(20 * HOUR_MS)), readAt: ago(30 * MINUTE_MS) }, NOW)).toBe(
      false,
    );
  });
});
