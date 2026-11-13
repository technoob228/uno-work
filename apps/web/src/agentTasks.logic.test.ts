import { ASSISTANT_PROJECT_ID, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  agentTaskDescendants,
  agentTaskReportLabel,
  agentTasksOf,
  agentTasksSummary,
  agentTaskStatus,
  archiveWithTasksPrompt,
  isAgentTask,
  isHiddenAgentTask,
  latestReportIdBySender,
} from "./agentTasks.logic";
import type { SidebarThreadSummary } from "./types";

const summary = (
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("p"),
  title: id,
  interactionMode: "default",
  session: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const session = (status: string, orchestrationStatus: string, lastError?: string) =>
  ({
    provider: "codex",
    status,
    createdAt: "x",
    updatedAt: "x",
    orchestrationStatus,
    ...(lastError ? { lastError } : {}),
  }) as unknown as SidebarThreadSummary["session"];

const parentId = ThreadId.make("coord");
const coordinator = summary("coord");
// A task of today's daemon: an agent started it, nobody called the person.
const task = (id: string, overrides: Partial<SidebarThreadSummary> = {}) =>
  summary(id, {
    spawnedByThreadId: parentId,
    startedBy: "agent",
    controller: "agent",
    ...overrides,
  });

describe("agentTaskStatus", () => {
  it("says where a task stands", () => {
    expect(agentTaskStatus(task("a", { session: session("running", "running") }))).toBe("working");
    expect(agentTaskStatus(task("b", { hasPendingApprovals: true }))).toBe("needs-you");
    expect(agentTaskStatus(task("c", { hasPendingUserInput: true }))).toBe("needs-you");
    expect(agentTaskStatus(task("d", { personCalledAt: "2026-11-13T10:05:00.000Z" }))).toBe(
      "needs-you",
    );
    expect(agentTaskStatus(task("e", { session: session("error", "error", "boom") }))).toBe(
      "error",
    );
    expect(
      agentTaskStatus(
        task("f", { childWork: { working: 1, latestStartedAt: "2026-11-13T10:00:00.000Z" } }),
      ),
    ).toBe("waiting");
    expect(agentTaskStatus(task("g"))).toBe("done");
  });

  it("a call the person already looked at is not Needs you any more", () => {
    expect(
      agentTaskStatus(
        task("a", {
          personCalledAt: "2026-11-13T10:05:00.000Z",
          readAt: "2026-11-13T10:06:00.000Z",
        }),
      ),
    ).toBe("done");
  });
});

describe("isAgentTask", () => {
  it("is a chat a live regular chat's agent started", () => {
    expect(isAgentTask(task("a"), coordinator, null)).toBe(true);
    expect(isAgentTask(summary("a"), undefined, null)).toBe(false);
  });

  it("not when the parent is gone, archived, Uno's chat or one of Uno's", () => {
    expect(isAgentTask(task("a"), undefined, null)).toBe(false);
    expect(
      isAgentTask(task("a"), summary("coord", { archivedAt: "2026-11-13T11:00:00.000Z" }), null),
    ).toBe(false);
    expect(isAgentTask(task("a"), coordinator, "coord")).toBe(false);
    expect(
      isAgentTask(task("a"), summary("coord", { projectId: ASSISTANT_PROJECT_ID }), null),
    ).toBe(false);
  });
});

describe("isHiddenAgentTask", () => {
  const base = { parent: coordinator, assistantChatId: null, showAgentTasks: false, isOpen: false };

  it("hides a task that does not need the person", () => {
    expect(isHiddenAgentTask({ ...base, thread: task("a") })).toBe(true);
    expect(
      isHiddenAgentTask({ ...base, thread: task("a", { session: session("running", "running") }) }),
    ).toBe(true);
  });

  it("shows it when it calls or asks the person", () => {
    expect(
      isHiddenAgentTask({
        ...base,
        thread: task("a", { personCalledAt: "2026-11-13T10:05:00.000Z" }),
      }),
    ).toBe(false);
    expect(isHiddenAgentTask({ ...base, thread: task("a", { hasPendingApprovals: true }) })).toBe(
      false,
    );
  });

  it("shows it with the switch on, while open, or once moved to the sidebar (pinned)", () => {
    expect(isHiddenAgentTask({ ...base, showAgentTasks: true, thread: task("a") })).toBe(false);
    expect(isHiddenAgentTask({ ...base, isOpen: true, thread: task("a") })).toBe(false);
    expect(
      isHiddenAgentTask({ ...base, thread: task("a", { pinnedAt: "2026-11-13T10:00:00.000Z" }) }),
    ).toBe(false);
  });

  it("never hides the person's own chats or an orphan", () => {
    expect(isHiddenAgentTask({ ...base, thread: summary("mine") })).toBe(false);
    expect(isHiddenAgentTask({ ...base, parent: undefined, thread: task("a") })).toBe(false);
  });
});

describe("agentTasksOf / agentTasksSummary", () => {
  it("lists a chat's live tasks, most urgent first", () => {
    const rows = agentTasksOf(parentId, [
      coordinator,
      task("done", { createdAt: "2026-11-13T10:01:00.000Z" }),
      task("working", { session: session("running", "running") }),
      task("asks", { hasPendingUserInput: true }),
      task("gone", { archivedAt: "2026-11-13T11:00:00.000Z" }),
      summary("other", { spawnedByThreadId: ThreadId.make("elsewhere") }),
    ]);
    expect(rows.map((row) => [row.task.id, row.status])).toEqual([
      ["asks", "needs-you"],
      ["working", "working"],
      ["done", "done"],
    ]);
    expect(agentTasksSummary(rows)).toBe("3 tasks · 1 needs you · 1 working · 1 done");
  });

  it("all done reads as such", () => {
    expect(agentTasksSummary(agentTasksOf(parentId, [task("a"), task("b")]))).toBe(
      "2 tasks · all done",
    );
    expect(agentTasksSummary(agentTasksOf(parentId, [task("a")]))).toBe("1 task · all done");
  });
});

describe("archiving a coordinator", () => {
  it("takes its tasks and their tasks, once each, even on a cycle", () => {
    const loop = ThreadId.make("b");
    const list = agentTaskDescendants(parentId, [
      coordinator,
      task("a"),
      task("b"),
      summary("b1", { spawnedByThreadId: loop }),
      summary("coord-again", { id: parentId, spawnedByThreadId: loop }),
      task("old", { archivedAt: "2026-11-13T11:00:00.000Z" }),
    ]);
    expect(list.map((row) => row.id)).toEqual(["a", "b", "b1"]);
  });

  it("asks first only while some of them still work", () => {
    expect(archiveWithTasksPrompt("Launch", [task("a")])).toBeNull();
    expect(
      archiveWithTasksPrompt("Launch", [
        task("a", { session: session("running", "running") }),
        task("b"),
      ]),
    ).toBe(
      'Archive chat "Launch"?\n1 of its agent tasks is still working: it will be stopped and archived too.',
    );
    expect(
      archiveWithTasksPrompt("Launch", [
        task("a", { session: session("running", "running") }),
        task("b", { hasPendingApprovals: true }),
      ]),
    ).toContain("2 of its agent tasks are still working");
  });
});

describe("a task's report in the coordinator's feed", () => {
  it("the latest report says where the task is; earlier ones are updates", () => {
    expect(agentTaskReportLabel({ title: "Copy", status: "done", latest: true })).toBe(
      "Task “Copy” is done",
    );
    expect(agentTaskReportLabel({ title: "Copy", status: "working", latest: true })).toBe(
      "Update from task “Copy”",
    );
    expect(agentTaskReportLabel({ title: "Copy", status: "done", latest: false })).toBe(
      "Update from task “Copy”",
    );
    expect(agentTaskReportLabel({ title: "Copy", status: "needs-you", latest: true })).toBe(
      "Task “Copy” needs you",
    );
    expect(agentTaskReportLabel({ title: null, status: "done", latest: true })).toBe(
      "A task is done",
    );
  });

  it("finds each task's latest message", () => {
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const latest = latestReportIdBySender([
      { id: "m1", role: "user", sentByThreadId: a },
      { id: "m2", role: "assistant" },
      { id: "m3", role: "user", sentByThreadId: b },
      { id: "m4", role: "user", sentByThreadId: a },
      { id: "m5", role: "user" },
    ]);
    expect(latest.get(a)).toBe("m4");
    expect(latest.get(b)).toBe("m3");
    expect(latest.size).toBe(2);
  });
});
