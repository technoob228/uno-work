import { ASSISTANT_PROJECT_ID, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  agentChatKind,
  agentChatsShelfLabel,
  agentTaskDescendants,
  agentTaskReportLabel,
  agentTasksOf,
  agentTasksSummary,
  agentTaskStatus,
  archiveWithTasksPrompt,
  groupAgentChats,
  handoffAction,
  isAgentTask,
  latestReportIdBySender,
  sidebarAgentPlacement,
  threadHandler,
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
const HANDED_AT = "2026-11-13T10:10:00.000Z";
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

describe("who handles a chat (Misha 14.11)", () => {
  it("an agent while controller says so, else the person", () => {
    expect(threadHandler(task("a"))).toBe("agent");
    expect(threadHandler(task("a", { controller: "human" }))).toBe("you");
    expect(threadHandler(summary("mine"))).toBe("you");
    expect(
      threadHandler(summary("handed", { controller: "agent", controlChangedAt: HANDED_AT })),
    ).toBe("agent");
    // Never handed off: a stray controller on the person's chat is not a handoff.
    expect(threadHandler(summary("mine", { controller: "agent" }))).toBe("you");
  });

  it("a subagent only when the agent said so; everything else is a thread", () => {
    expect(agentChatKind(task("a", { spawnKind: "subagent" }))).toBe("subagent");
    expect(agentChatKind(task("a", { spawnKind: "thread" }))).toBe("thread");
    expect(agentChatKind(task("a"))).toBe("thread");
    // The person's own chat handed off is a thread, whatever it says.
    expect(agentChatKind(summary("mine", { spawnKind: "subagent" }))).toBe("thread");
  });

  it("offers Join while an agent handles it, Hand to agent while the person does", () => {
    expect(handoffAction(task("a"))).toMatchObject({ label: "Join", nextController: "human" });
    expect(handoffAction(task("a", { controller: "human" }))).toMatchObject({
      label: "Hand to agent",
      nextController: "agent",
    });
    expect(handoffAction(summary("mine"))).toMatchObject({ nextController: "agent" });
    // Not Uno's chat; not the person's own on a daemon without chatHandoff.
    expect(handoffAction(summary("uno", { assistantRole: "chat" }))).toBeNull();
    expect(handoffAction(summary("mine"), { ownChats: false })).toBeNull();
    expect(handoffAction(task("a", { controller: "human" }), { ownChats: false })).not.toBeNull();
  });
});

describe("sidebarAgentPlacement", () => {
  type PlaceInput = Parameters<typeof sidebarAgentPlacement>[0];
  const base: Omit<PlaceInput, "thread"> = {
    parent: coordinator,
    assistantChatId: null,
    inline: { threads: false, subagents: false },
  };
  const place = (
    thread: SidebarThreadSummary,
    overrides: { -readonly [K in keyof Omit<PlaceInput, "thread">]?: PlaceInput[K] } = {},
  ) => sidebarAgentPlacement({ ...base, ...overrides, thread });

  it("puts a chat an agent handles behind the Agents' chats button", () => {
    expect(place(task("a"))).toBe("agents");
    expect(place(task("a", { session: session("running", "running") }))).toBe("agents");
    expect(place(task("a", { spawnKind: "subagent" }))).toBe("agents");
    // The person's own chat they handed to its agent: no parent to check.
    expect(
      place(summary("handed", { controller: "agent", controlChangedAt: HANDED_AT }), {
        parent: undefined,
      }),
    ).toBe("agents");
  });

  it("keeps it in the list once the person joined it", () => {
    expect(place(task("a", { controller: "human" }))).toBe("list");
    expect(place(summary("mine"))).toBe("list");
  });

  it("keeps it in the list while it needs the person, or pinned", () => {
    expect(place(task("a", { personCalledAt: "2026-11-13T10:05:00.000Z" }))).toBe("list");
    expect(place(task("a", { hasPendingApprovals: true }))).toBe("list");
    expect(place(task("a", { pinnedAt: "2026-11-13T10:00:00.000Z" }))).toBe("list");
    expect(
      place(
        summary("handed", {
          controller: "agent",
          controlChangedAt: HANDED_AT,
          hasPendingUserInput: true,
        }),
        {
          parent: undefined,
        },
      ),
    ).toBe("list");
  });

  it("the view menu puts threads and subagents back inline, each on its own", () => {
    const sub = task("s", { spawnKind: "subagent" });
    const inlineThreads = { inline: { threads: true, subagents: false } };
    expect(place(task("t"), inlineThreads)).toBe("list");
    expect(place(sub, inlineThreads)).toBe("agents");
    expect(place(sub, { inline: { threads: false, subagents: true } })).toBe("list");
  });

  it("an orphan, one of Uno's or Uno's own chat stays in the list, as before", () => {
    expect(place(task("a"), { parent: undefined })).toBe("list");
    expect(place(task("a"), { assistantChatId: "coord" })).toBe("list");
    expect(
      place(summary("uno", { assistantRole: "chat", controller: "agent" }), { parent: undefined }),
    ).toBe("list");
  });

  it("groups the button's chats: threads, then subagents, newest first", () => {
    const groups = groupAgentChats([
      task("old-thread", { updatedAt: "2026-11-13T09:00:00.000Z" }),
      task("sub", { spawnKind: "subagent", updatedAt: "2026-11-13T10:00:00.000Z" }),
      task("new-thread", { updatedAt: "2026-11-13T11:00:00.000Z" }),
      summary("handed", {
        controller: "agent",
        controlChangedAt: HANDED_AT,
        updatedAt: "2026-11-13T10:30:00.000Z",
      }),
    ]);
    expect(groups.threads.map((chat) => chat.id)).toEqual(["new-thread", "handed", "old-thread"]);
    expect(groups.subagents.map((chat) => chat.id)).toEqual(["sub"]);
    expect(agentChatsShelfLabel(4, false)).toBe("Agents' chats (4)");
    expect(agentChatsShelfLabel(4, true)).toBe("Agents' chats");
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
    expect(agentTasksSummary(rows)).toBe("3 threads · 1 needs you · 1 working · 1 done");
  });

  it("threads first, then subagents, with who handles each", () => {
    const rows = agentTasksOf(parentId, [
      task("sub-asks", { spawnKind: "subagent", hasPendingUserInput: true }),
      task("joined", { controller: "human" }),
      task("thread"),
    ]);
    expect(rows.map((row) => [row.task.id, row.kind, row.handler])).toEqual([
      ["joined", "thread", "you"],
      ["thread", "thread", "agent"],
      ["sub-asks", "subagent", "agent"],
    ]);
    expect(agentTasksSummary(rows)).toBe("2 threads · 1 subagent · 1 needs you · 2 done");
  });

  it("all done reads as such", () => {
    expect(agentTasksSummary(agentTasksOf(parentId, [task("a"), task("b")]))).toBe(
      "2 threads · all done",
    );
    expect(agentTasksSummary(agentTasksOf(parentId, [task("a", { spawnKind: "subagent" })]))).toBe(
      "1 subagent · all done",
    );
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
