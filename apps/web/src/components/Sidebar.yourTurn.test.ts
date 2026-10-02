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
import { isThreadSettled, resolveSidebarThreadSection } from "./Sidebar.sections";
import { countChatsWaitingOnYou, isYourTurn, YOUR_TURN_SINCE } from "./Sidebar.yourTurn";

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
