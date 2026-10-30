import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type CleanupThread,
  ACTIVITY_GRACE_MS,
  DAY_MS,
  cleanupEnabled,
  deletedThreadVerdict,
  doneSinceMs,
  effectiveRules,
  isLowDisk,
  liveThreadVerdict,
  threadBusyReason,
} from "./policy.ts";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const GB = 1024 ** 3;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const defaults = DEFAULT_SERVER_SETTINGS.storageCleanup;

function thread(overrides: Partial<CleanupThread> = {}, idleMs = 1 * DAY_MS): CleanupThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Fix the login form",
    branch: "t3code/fix-login",
    worktreePath: "/home/uno/.t3/worktrees/app/fix-login",
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: ago(idleMs + 60_000),
      startedAt: ago(idleMs + 60_000),
      completedAt: ago(idleMs),
      assistantMessageId: null,
    },
    createdAt: ago(idleMs + DAY_MS),
    archivedAt: null,
    pinnedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: ago(idleMs + 60_000),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

const rules = (lowDisk = false) => effectiveRules(defaults, lowDisk);

describe("worktree cleanup defaults", () => {
  it("are all on: delete, Done/archived after 3 days, any chat after 14, low disk, save changes", () => {
    expect(defaults).toEqual({
      worktreeOnDelete: true,
      worktreeSettledAfterDays: 3,
      worktreeAfterDays: 14,
      worktreeLowDisk: true,
      worktreeSaveChanges: true,
    });
    expect(cleanupEnabled(rules())).toBe(true);
  });

  it("is off only when every rule is off", () => {
    expect(
      cleanupEnabled(
        effectiveRules(
          {
            ...defaults,
            worktreeOnDelete: false,
            worktreeSettledAfterDays: null,
            worktreeAfterDays: null,
          },
          true,
        ),
      ),
    ).toBe(false);
  });
});

describe("isLowDisk", () => {
  it("matches the Computer page warning: 85% used or under 3 GB free", () => {
    expect(isLowDisk(null)).toBe(false);
    expect(isLowDisk({ totalBytes: 0, freeBytes: 0 })).toBe(false);
    expect(isLowDisk({ totalBytes: 100 * GB, freeBytes: 20 * GB })).toBe(false);
    expect(isLowDisk({ totalBytes: 100 * GB, freeBytes: 15 * GB })).toBe(true);
    expect(isLowDisk({ totalBytes: 100 * GB, freeBytes: 14 * GB })).toBe(true);
    expect(isLowDisk({ totalBytes: 10 * GB, freeBytes: 2.9 * GB })).toBe(true);
    expect(isLowDisk({ totalBytes: 10 * GB, freeBytes: 3.5 * GB })).toBe(false);
  });
});

describe("effectiveRules under disk pressure", () => {
  it("shrinks Done/archived to 0 days and idle to 3", () => {
    expect(rules(true)).toEqual({
      onDelete: true,
      settledAfterDays: 0,
      afterDays: 3,
      saveChanges: true,
      lowDisk: true,
    });
  });

  it("never turns on a rule the person turned off, and never lengthens a shorter one", () => {
    const custom = effectiveRules(
      { ...defaults, worktreeSettledAfterDays: null, worktreeAfterDays: 1 },
      true,
    );
    expect(custom.settledAfterDays).toBeNull();
    expect(custom.afterDays).toBe(1);
  });

  it("does nothing when the low-disk switch is off", () => {
    expect(effectiveRules({ ...defaults, worktreeLowDisk: false }, true)).toEqual(rules(false));
  });
});

describe("threadBusyReason", () => {
  it("keeps a chat whose agent is working", () => {
    expect(
      threadBusyReason(
        thread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            lastError: null,
            updatedAt: ago(DAY_MS),
          },
        }),
        NOW,
      ),
    ).toBe("The agent is working in this chat");
    const running = thread({}, 2 * 60 * 60_000);
    expect(
      threadBusyReason(
        { ...running, latestTurn: { ...running.latestTurn!, state: "running" } },
        NOW,
      ),
    ).toBe("The agent is working in this chat");
  });

  it("does not trust a turn left 'running' for days (a crash leftover)", () => {
    const stale = thread({}, 5 * DAY_MS);
    expect(
      threadBusyReason({ ...stale, latestTurn: { ...stale.latestTurn!, state: "running" } }, NOW),
    ).toBeNull();
  });

  it("keeps a chat that waits for an answer, however old", () => {
    expect(threadBusyReason(thread({ hasPendingApprovals: true }, 30 * DAY_MS), NOW)).toBe(
      "The chat is waiting for your answer",
    );
    expect(threadBusyReason(thread({ hasPendingUserInput: true }, 30 * DAY_MS), NOW)).toBe(
      "The chat is waiting for your answer",
    );
  });

  it("keeps anything touched in the last few minutes, Done and archive included", () => {
    expect(threadBusyReason(thread({}, ACTIVITY_GRACE_MS - 1000), NOW)).toBe(
      "Used a few minutes ago",
    );
    expect(threadBusyReason(thread({ settledAt: ago(60_000) }, 30 * DAY_MS), NOW)).toBe(
      "Used a few minutes ago",
    );
    expect(threadBusyReason(thread({ archivedAt: ago(60_000) }, 30 * DAY_MS), NOW)).toBe(
      "Used a few minutes ago",
    );
    expect(threadBusyReason(thread({}, ACTIVITY_GRACE_MS + 1000), NOW)).toBeNull();
  });
});

describe("doneSinceMs", () => {
  it("counts a finished chat idle 3 days as Done, like the sidebar", () => {
    expect(doneSinceMs(thread({}, 2 * DAY_MS), NOW)).toBeNull();
    expect(doneSinceMs(thread({}, 3 * DAY_MS), NOW)).toBe(NOW - 3 * DAY_MS);
  });

  it("follows Done by hand, Un-done and pins", () => {
    expect(
      doneSinceMs(thread({ settledOverride: "settled", settledAt: ago(DAY_MS) }, 2 * DAY_MS), NOW),
    ).toBe(NOW - DAY_MS);
    expect(doneSinceMs(thread({ settledOverride: "active" }, 30 * DAY_MS), NOW)).toBeNull();
    expect(doneSinceMs(thread({ pinnedAt: ago(DAY_MS) }, 30 * DAY_MS), NOW)).toBeNull();
  });

  it("never counts a chat that never finished a turn", () => {
    expect(doneSinceMs(thread({ latestTurn: null }, 30 * DAY_MS), NOW)).toBeNull();
  });

  it("keeps a chat with an open PR out of Done, but not on a link nobody reads", () => {
    const snapshot = {
      title: "Fix",
      state: "open",
      isDraft: false,
      headBranch: "fix",
      baseBranch: "main",
      updatedAt: ago(DAY_MS),
      mergedAt: null,
      closedAt: null,
      checks: "none",
      review: "none",
    } as const;
    const link = (syncedAt: string, state: "open" | "merged" = "open") =>
      ({
        provider: "github",
        repository: "getuno/app",
        number: 12,
        url: "https://github.com/getuno/app/pull/12",
        source: "branch",
        linkedAt: ago(4 * DAY_MS),
        snapshot: { ...snapshot, state, syncedAt },
      }) as NonNullable<CleanupThread["pullRequests"]>[number];
    const done = NOW - 4 * DAY_MS;
    expect(doneSinceMs(thread({ pullRequests: [link(ago(DAY_MS))] }, 4 * DAY_MS), NOW)).toBeNull();
    expect(doneSinceMs(thread({ pullRequests: [link(ago(15 * DAY_MS))] }, 4 * DAY_MS), NOW)).toBe(
      done,
    );
    expect(
      doneSinceMs(thread({ pullRequests: [link(ago(DAY_MS), "merged")] }, 4 * DAY_MS), NOW),
    ).toBe(done);
  });
});

describe("liveThreadVerdict", () => {
  it("keeps a chat used yesterday", () => {
    expect(liveThreadVerdict(thread({}, DAY_MS), rules(), NOW)).toEqual({
      remove: false,
      reason: "Used 1 day ago",
    });
  });

  it("removes a Done chat quiet for 3 days", () => {
    expect(
      liveThreadVerdict(
        thread({ settledOverride: "settled", settledAt: ago(3 * DAY_MS) }, 4 * DAY_MS),
        rules(),
        NOW,
      ),
    ).toEqual({ remove: true, reason: "Done chat, quiet for 4 days" });
    expect(
      liveThreadVerdict(
        thread({ settledOverride: "settled", settledAt: ago(2 * DAY_MS) }, 4 * DAY_MS),
        rules(),
        NOW,
      ).remove,
    ).toBe(false);
  });

  it("removes an archived chat 3 days after the archive", () => {
    expect(
      liveThreadVerdict(
        thread({ archivedAt: ago(3 * DAY_MS), pinnedAt: ago(9 * DAY_MS) }, 10 * DAY_MS),
        rules(),
        NOW,
      ),
    ).toEqual({ remove: true, reason: "archived chat, quiet for 3 days" });
    expect(
      liveThreadVerdict(
        thread({ archivedAt: ago(DAY_MS), latestTurn: null }, 10 * DAY_MS),
        rules(),
        NOW,
      ),
    ).toEqual({ remove: false, reason: "Archived 1 day ago" });
    // A finished chat idle that long is Done anyway, archived or not.
    expect(
      liveThreadVerdict(thread({ archivedAt: ago(DAY_MS) }, 10 * DAY_MS), rules(), NOW),
    ).toEqual({ remove: true, reason: "Done chat, quiet for 10 days" });
  });

  it("removes any chat quiet for 14 days, even pinned or never finished", () => {
    expect(
      liveThreadVerdict(thread({ pinnedAt: ago(20 * DAY_MS) }, 14 * DAY_MS), rules(), NOW),
    ).toEqual({ remove: true, reason: "not used for 14 days" });
    expect(liveThreadVerdict(thread({ latestTurn: null }, 13 * DAY_MS), rules(), NOW).remove).toBe(
      false,
    );
  });

  it("under disk pressure: Done right away, any chat after 3 days", () => {
    expect(
      liveThreadVerdict(
        thread({ settledOverride: "settled", settledAt: ago(ACTIVITY_GRACE_MS * 2) }, DAY_MS),
        rules(true),
        NOW,
      ),
    ).toEqual({ remove: true, reason: "Disk nearly full: Done chat, quiet for 1 day" });
    expect(
      liveThreadVerdict(thread({ pinnedAt: ago(DAY_MS) }, 3 * DAY_MS), rules(true), NOW),
    ).toEqual({
      remove: true,
      reason: "Disk nearly full: not used for 3 days",
    });
    expect(
      liveThreadVerdict(thread({ pinnedAt: ago(DAY_MS) }, 2 * DAY_MS), rules(true), NOW).remove,
    ).toBe(false);
  });

  it("keeps everything when the rules are off", () => {
    const off = effectiveRules(
      { ...defaults, worktreeSettledAfterDays: null, worktreeAfterDays: null },
      true,
    );
    expect(
      liveThreadVerdict(thread({ archivedAt: ago(90 * DAY_MS) }, 90 * DAY_MS), off, NOW).remove,
    ).toBe(false);
  });
});

describe("deletedThreadVerdict", () => {
  it("removes the copy of a deleted chat unless that rule is off", () => {
    expect(deletedThreadVerdict(rules()).remove).toBe(true);
    expect(
      deletedThreadVerdict(effectiveRules({ ...defaults, worktreeOnDelete: false }, true)).remove,
    ).toBe(false);
  });
});
