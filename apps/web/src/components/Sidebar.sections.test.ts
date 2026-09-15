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
  SIDEBAR_SETTLED_PREVIEW_LIMIT,
  buildSidebarInboxLayout,
  isThreadSettled,
  partitionSidebarThreads,
  resolveSidebarProjectThreadList,
  resolveSidebarThreadSection,
} from "./Sidebar.sections";

const NOW = "2026-09-13T12:00:00.000Z";
const HOUR_MS = 60 * 60 * 1_000;
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

function session(status: ThreadSession["status"], updatedAt = NOW): ThreadSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status,
    createdAt: updatedAt,
    updatedAt,
    orchestrationStatus: status === "running" ? "running" : status === "error" ? "error" : "ready",
  };
}

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env-local"),
    projectId: ProjectId.make("project-1"),
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: ago(10 * DAY_MS),
    archivedAt: null,
    pinnedAt: null,
    updatedAt: ago(HOUR_MS),
    latestTurn: completedTurn(ago(HOUR_MS)),
    branch: null,
    worktreePath: null,
    latestUserMessageAt: ago(HOUR_MS),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    snoozedUntil: null,
    snoozedAt: null,
    ...overrides,
  };
}

const idle = (days: number) => ({
  latestTurn: completedTurn(ago(days * DAY_MS)),
  latestUserMessageAt: ago(days * DAY_MS),
});
const snoozed = (untilMs: number, snoozedAgoMs = 10 * 60 * 1_000) => ({
  snoozedUntil: ahead(untilMs),
  snoozedAt: ago(snoozedAgoMs),
});
const threadKey = (thread: SidebarThreadSummary) => thread.id;

describe("resolveSidebarThreadSection", () => {
  it("puts a recently finished thread in Active", () => {
    expect(resolveSidebarThreadSection(makeThread("recent"), NOW)).toBe("active");
  });

  it("puts a pinned thread in Pinned", () => {
    expect(resolveSidebarThreadSection(makeThread("pinned", { pinnedAt: ago(DAY_MS) }), NOW)).toBe(
      "pinned",
    );
  });

  it("settles a thread idle for more than three days", () => {
    expect(resolveSidebarThreadSection(makeThread("old", idle(4)), NOW)).toBe("settled");
    expect(resolveSidebarThreadSection(makeThread("young", idle(2)), NOW)).toBe("active");
  });

  it("never settles a pinned thread", () => {
    const thread = makeThread("pinned-old", { ...idle(30), pinnedAt: ago(40 * DAY_MS) });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("pinned");
  });

  it("keeps a thread that never ran a turn active", () => {
    const thread = makeThread("empty", { latestTurn: null, latestUserMessageAt: null });
    expect(isThreadSettled(thread, NOW)).toBe(false);
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("keeps an old thread whose agent is running active", () => {
    const thread = makeThread("running", {
      ...idle(10),
      latestTurn: { ...completedTurn(ago(10 * DAY_MS)), completedAt: null, state: "running" },
      session: session("running"),
    });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("moves a snoozed thread to the shelf", () => {
    expect(resolveSidebarThreadSection(makeThread("snoozed", snoozed(HOUR_MS)), NOW)).toBe(
      "snoozed",
    );
  });

  it("snooze wins over pin and over settled", () => {
    const pinnedSnoozed = makeThread("p", { ...snoozed(HOUR_MS), pinnedAt: ago(DAY_MS) });
    const oldSnoozed = makeThread("o", { ...idle(10), ...snoozed(HOUR_MS) });
    expect(resolveSidebarThreadSection(pinnedSnoozed, NOW)).toBe("snoozed");
    expect(resolveSidebarThreadSection(oldSnoozed, NOW)).toBe("snoozed");
  });

  it("wakes a snoozed thread when its wake time passes (computed on read)", () => {
    const thread = makeThread("expired", { snoozedUntil: ago(60_000), snoozedAt: ago(HOUR_MS) });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("ignores a malformed wake time instead of hiding the thread", () => {
    const thread = makeThread("broken", { snoozedUntil: "not-a-date", snoozedAt: ago(HOUR_MS) });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("wakes a snoozed thread that needs the person", () => {
    const approval = makeThread("approval", { ...snoozed(DAY_MS), hasPendingApprovals: true });
    const question = makeThread("question", { ...snoozed(DAY_MS), hasPendingUserInput: true });
    expect(resolveSidebarThreadSection(approval, NOW)).toBe("active");
    expect(resolveSidebarThreadSection(question, NOW)).toBe("active");
  });

  it("wakes a snoozed thread whose run finished after the snooze", () => {
    const thread = makeThread("finished", {
      snoozedUntil: ahead(DAY_MS),
      snoozedAt: ago(2 * HOUR_MS),
      latestTurn: completedTurn(ago(HOUR_MS)),
    });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("wakes on a failure after the snooze but not on one the person already saw", () => {
    const freshFailure = makeThread("fresh", {
      snoozedUntil: ahead(DAY_MS),
      snoozedAt: ago(3 * HOUR_MS),
      latestTurn: completedTurn(ago(4 * HOUR_MS)),
      session: session("error", ago(HOUR_MS)),
    });
    const seenFailure = makeThread("seen", {
      snoozedUntil: ahead(DAY_MS),
      snoozedAt: ago(HOUR_MS),
      latestTurn: completedTurn(ago(4 * HOUR_MS)),
      session: session("error", ago(3 * HOUR_MS)),
    });
    expect(resolveSidebarThreadSection(freshFailure, NOW)).toBe("active");
    expect(resolveSidebarThreadSection(seenFailure, NOW)).toBe("snoozed");
  });

  it("keeps a pinned thread that needs the person in Pinned", () => {
    const thread = makeThread("pinned-approval", {
      pinnedAt: ago(DAY_MS),
      hasPendingApprovals: true,
      ...snoozed(DAY_MS),
    });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("pinned");
  });
});

describe("partitionSidebarThreads", () => {
  it("orders Active with threads that need the person on top", () => {
    const newest = makeThread("newest", { latestUserMessageAt: ago(60_000) });
    const needsYou = makeThread("needs-you", {
      latestUserMessageAt: ago(2 * DAY_MS),
      hasPendingApprovals: true,
    });
    const older = makeThread("older", { latestUserMessageAt: ago(DAY_MS) });
    const { active } = partitionSidebarThreads([older, newest, needsYou], {
      now: NOW,
      sortOrder: "updated_at",
    });
    expect(active.map((thread) => thread.id)).toEqual(["needs-you", "newest", "older"]);
  });

  it("orders Pinned by most recent pin, Snoozed by soonest wake, Settled by latest activity", () => {
    const sections = partitionSidebarThreads(
      [
        makeThread("pin-old", { pinnedAt: ago(3 * DAY_MS) }),
        makeThread("pin-new", { pinnedAt: ago(DAY_MS) }),
        makeThread("wake-late", snoozed(2 * DAY_MS)),
        makeThread("wake-soon", snoozed(HOUR_MS)),
        makeThread("settled-older", idle(20)),
        makeThread("settled-newer", idle(5)),
      ],
      { now: NOW, sortOrder: "created_at" },
    );
    expect(sections.pinned.map((thread) => thread.id)).toEqual(["pin-new", "pin-old"]);
    expect(sections.snoozed.map((thread) => thread.id)).toEqual(["wake-soon", "wake-late"]);
    expect(sections.settled.map((thread) => thread.id)).toEqual(["settled-newer", "settled-older"]);
  });
});

describe("buildSidebarInboxLayout", () => {
  const settledThreads = Array.from({ length: SIDEBAR_SETTLED_PREVIEW_LIMIT + 2 }, (_, index) =>
    makeThread(`settled-${index}`, idle(5 + index)),
  );
  const threads = [
    makeThread("pinned", { pinnedAt: ago(DAY_MS) }),
    makeThread("active"),
    makeThread("snoozed-a", snoozed(HOUR_MS)),
    makeThread("snoozed-b", snoozed(2 * HOUR_MS)),
    ...settledThreads,
  ];

  it("renders Pinned, Active, a collapsed Snoozed shelf and the first settled rows", () => {
    const layout = buildSidebarInboxLayout(threads, {
      now: NOW,
      sortOrder: "updated_at",
      snoozedExpanded: false,
      settledExpanded: false,
      threadKey,
    });
    expect(
      layout.items.map((item) =>
        item.kind === "thread" ? `${item.section}:${item.thread.id}` : item.kind,
      ),
    ).toEqual([
      "pinned:pinned",
      "active:active",
      "snoozed-header",
      "settled-header",
      "settled:settled-0",
      "settled:settled-1",
      "settled:settled-2",
      "settled:settled-3",
      "settled:settled-4",
      "settled-toggle",
    ]);
    expect(layout.items[2]).toEqual({ kind: "snoozed-header", count: 2, expanded: false });
    expect(layout.items.at(-1)).toEqual({
      kind: "settled-toggle",
      hiddenCount: 2,
      expanded: false,
    });
    expect(layout.hiddenThreads.map((thread) => thread.id)).toEqual([
      "snoozed-a",
      "snoozed-b",
      "settled-5",
      "settled-6",
    ]);
  });

  it("shows every row when both shelves are expanded", () => {
    const layout = buildSidebarInboxLayout(threads, {
      now: NOW,
      sortOrder: "updated_at",
      snoozedExpanded: true,
      settledExpanded: true,
      threadKey,
    });
    expect(layout.visibleThreads).toHaveLength(threads.length);
    expect(layout.hiddenThreads).toEqual([]);
  });

  it("keeps the open chat visible inside a collapsed shelf", () => {
    const layout = buildSidebarInboxLayout(threads, {
      now: NOW,
      sortOrder: "updated_at",
      snoozedExpanded: false,
      settledExpanded: false,
      threadKey,
      forceVisibleKey: "snoozed-b",
    });
    expect(layout.visibleThreads.map((thread) => thread.id)).toContain("snoozed-b");
    expect(layout.visibleThreads.map((thread) => thread.id)).not.toContain("snoozed-a");
  });

  it("omits empty section markers", () => {
    const layout = buildSidebarInboxLayout([makeThread("only")], {
      now: NOW,
      sortOrder: "updated_at",
      snoozedExpanded: false,
      settledExpanded: false,
      threadKey,
    });
    expect(layout.items).toEqual([
      { kind: "thread", thread: expect.objectContaining({ id: "only" }), section: "active" },
    ]);
  });
});

describe("resolveSidebarProjectThreadList", () => {
  const base = {
    now: NOW,
    sortOrder: "updated_at" as const,
    projectExpanded: true,
    activeThreadKey: null,
    isThreadListExpanded: false,
    snoozedExpanded: false,
    previewLimit: 2,
    threadKey,
  };
  const threads = [
    makeThread("a", { latestUserMessageAt: ago(1_000) }),
    makeThread("b", { latestUserMessageAt: ago(2_000) }),
    makeThread("c", { ...snoozed(HOUR_MS), latestUserMessageAt: ago(3_000) }),
  ];

  it("keeps the historical flat list when inbox sections are off", () => {
    const list = resolveSidebarProjectThreadList({ ...base, threads, inboxSections: false });
    expect(list.renderedThreads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(list.hasOverflowingThreads).toBe(true);
    expect(list.hiddenThreads.map((thread) => thread.id)).toEqual(["c"]);
    expect(list.items.every((item) => item.kind === "thread")).toBe(true);
  });

  it("uses sections (no flat preview limit) when inbox sections are on", () => {
    const list = resolveSidebarProjectThreadList({ ...base, threads, inboxSections: true });
    expect(list.renderedThreads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(list.hasOverflowingThreads).toBe(false);
    expect(list.orderedThreads.map((thread) => thread.id)).toEqual(["a", "b", "c"]);
  });

  it("shows only the open chat in a collapsed project, even from the snoozed shelf", () => {
    const list = resolveSidebarProjectThreadList({
      ...base,
      threads,
      inboxSections: true,
      projectExpanded: false,
      activeThreadKey: "c",
    });
    expect(list.shouldShowThreadPanel).toBe(true);
    expect(list.items).toEqual([
      { kind: "thread", thread: expect.objectContaining({ id: "c" }), section: "snoozed" },
    ]);
  });

  it("hides everything in a collapsed project without an open chat", () => {
    const list = resolveSidebarProjectThreadList({
      ...base,
      threads,
      inboxSections: true,
      projectExpanded: false,
    });
    expect(list.shouldShowThreadPanel).toBe(false);
    expect(list.items).toEqual([]);
  });
});

describe("manual settle override", () => {
  it("settles an explicitly settled thread even when it was active a minute ago", () => {
    const thread = makeThread("parked", { settledOverride: "settled", settledAt: ago(60_000) });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("settled");
  });

  it("keeps an un-settled thread out of the idle auto-settle", () => {
    const thread = makeThread("pulled-back", { ...idle(10), settledOverride: "active" });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("never hides a thread that needs the person, even when settled", () => {
    const thread = makeThread("asks", {
      settledOverride: "settled",
      settledAt: ago(HOUR_MS),
      hasPendingApprovals: true,
    });
    expect(resolveSidebarThreadSection(thread, NOW)).toBe("active");
  });

  it("orders the settled tail by settle time before last activity", () => {
    const settledRecently = makeThread("settled-recently", {
      ...idle(20),
      settledOverride: "settled",
      settledAt: ago(HOUR_MS),
    });
    const autoSettled = makeThread("auto-settled", idle(4));
    const { settled } = partitionSidebarThreads([autoSettled, settledRecently], {
      now: NOW,
      sortOrder: "updated_at",
    });
    expect(settled.map((thread) => thread.id)).toEqual(["settled-recently", "auto-settled"]);
  });
});
