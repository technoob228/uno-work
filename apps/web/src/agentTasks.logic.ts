// Agent tasks (Misha 13.11, v2 14.11): who handles a chat — the person or an
// agent — and where the chats agents handle live.
// - Every chat has a handler: the person ("you") or an agent (`controller`
//   "agent"). A chat another chat's agent started is the agent's until the
//   person joins it (Join, or simply writes there); the person may hand any
//   chat of theirs to its agent ("Hand to agent") and join it again.
// - Two kinds of chats agents start (`spawnKind`, said in chat_create):
//   subagents — short helpers on any harness — and threads — long work chats
//   the agent runs, the ones worth joining. A chat the person handed off is a
//   thread.
// - The sidebar keeps the agents' chats out of the list, under one
//   "Agents' chats" button (threads, then subagents); the view menu puts
//   threads and/or subagents back inline. A chat that needs the person (a
//   question, an approval, a call) is in the list whoever handles it, and so
//   is a pinned one.
// - The chat that started them lists them in its "Tasks" strip, threads and
//   subagents apart; its feed folds a task's report into one line; archiving
//   it archives them (and theirs).
// Pure, so the sidebar, the strip and the feed say the same thing.
import type { ThreadController, ThreadId } from "@t3tools/contracts";

import { HANDLER_COPY } from "./agentThreads.logic";
import { isRegularListChat } from "./assistant/assistantChat.logic";
import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";
import { isPersonCallPending } from "./components/Sidebar.owner";
import { threadNeedsUser } from "./components/Sidebar.snooze";
import type { SidebarThreadSummary } from "./types";

/** The view menu's "Agents' threads" switch: in the list, not behind the button (this device). */
export const SIDEBAR_INLINE_AGENT_THREADS_KEY = "uno-work:sidebar:inline-agent-threads";
/** The view menu's "Subagents" switch, the same for subagents. */
export const SIDEBAR_INLINE_SUBAGENTS_KEY = "uno-work:sidebar:inline-subagents";

/** Who handles a chat now: the person, or an agent. */
export type ThreadHandler = "you" | "agent";

/** What an agents' chat is: a short helper or a long work chat. */
export type AgentChatKind = "subagent" | "thread";

export const AGENT_CHAT_KIND_LABEL: Readonly<Record<AgentChatKind, string>> = {
  thread: "Threads",
  subagent: "Subagents",
};

export type AgentTaskStatus = "needs-you" | "working" | "waiting" | "error" | "stopped" | "done";

export const AGENT_TASK_STATUS_LABEL: Readonly<Record<AgentTaskStatus, string>> = {
  "needs-you": "Needs you",
  working: "Working",
  waiting: "Waiting",
  error: "Error",
  stopped: "Stopped",
  done: "Done",
};

/** Most urgent first: what the strip lists on top and counts in its summary. */
const STATUS_ORDER: ReadonlyArray<AgentTaskStatus> = [
  "needs-you",
  "error",
  "working",
  "waiting",
  "stopped",
  "done",
];

type TaskSummary = SidebarThreadSummary;

/**
 * Where a task stands: needs the person (a question, an approval, an agent
 * called them in), working, waiting on its own tasks, failed, cut off by a
 * restart, or done.
 */
export function agentTaskStatus(task: TaskSummary): AgentTaskStatus {
  if (threadNeedsUser(task) || isPersonCallPending(task)) return "needs-you";
  switch (resolveSidebarThreadStatus(task)) {
    case "working":
      return "working";
    case "failed":
      return "error";
    case "stopped":
      return "stopped";
    default:
      return (task.childWork?.working ?? 0) > 0 ? "waiting" : "done";
  }
}

/** A task's parent is a chat the sidebar lists (not Uno's) and is still there. */
function isCoordinator(
  parent: Pick<TaskSummary, "id" | "projectId" | "archivedAt"> | undefined,
  assistantChatId: string | null,
): boolean {
  return (
    parent !== undefined && parent.archivedAt === null && isRegularListChat(parent, assistantChatId)
  );
}

/**
 * This chat is a task of another chat: started by its agent, and that chat is
 * a live regular chat. A chat whose parent is gone, archived or Uno's is not.
 */
export function isAgentTask(
  thread: Pick<TaskSummary, "spawnedByThreadId">,
  parent: Pick<TaskSummary, "id" | "projectId" | "archivedAt"> | undefined,
  assistantChatId: string | null,
): boolean {
  return thread.spawnedByThreadId != null && isCoordinator(parent, assistantChatId);
}

/**
 * Who handles it: an agent while `controller` says so — a spawned chat starts
 * so; the person's own chat only after they handed it off (`controlChangedAt`).
 */
export function threadHandler(
  thread: Pick<TaskSummary, "controller" | "spawnedByThreadId" | "controlChangedAt">,
): ThreadHandler {
  if (thread.controller !== "agent") return "you";
  return thread.spawnedByThreadId != null || thread.controlChangedAt != null ? "agent" : "you";
}

/** A subagent only when the agent that started it said so; anything else is a thread. */
export function agentChatKind(
  thread: Pick<TaskSummary, "spawnedByThreadId" | "spawnKind">,
): AgentChatKind {
  return thread.spawnedByThreadId != null && thread.spawnKind === "subagent"
    ? "subagent"
    : "thread";
}

export type SidebarAgentPlacement = "list" | "agents";

/**
 * Where the sidebar shows a chat: in the list, or behind the "Agents' chats"
 * button (see the top of the file). `parent` is the chat named by
 * `spawnedByThreadId`, in the same environment; `inline` — the view menu's
 * switches. A chat whose parent is gone, archived or Uno's keeps its place
 * in the list, as before.
 */
export function sidebarAgentPlacement(input: {
  readonly thread: TaskSummary;
  readonly parent: TaskSummary | undefined;
  readonly assistantChatId: string | null;
  readonly inline: { readonly threads: boolean; readonly subagents: boolean };
}): SidebarAgentPlacement {
  const { thread } = input;
  if (threadHandler(thread) === "you") return "list";
  if (thread.assistantRole === "chat") return "list";
  if (
    thread.spawnedByThreadId != null &&
    !isAgentTask(thread, input.parent, input.assistantChatId)
  ) {
    return "list";
  }
  if (thread.pinnedAt !== null || agentTaskNeedsPerson(thread)) return "list";
  const kind = agentChatKind(thread);
  if (kind === "thread" ? input.inline.threads : input.inline.subagents) return "list";
  return "agents";
}

/** The chats behind the "Agents' chats" button: threads, then subagents, newest first. */
export function groupAgentChats<T extends TaskSummary>(
  chats: ReadonlyArray<T>,
): { readonly threads: ReadonlyArray<T>; readonly subagents: ReadonlyArray<T> } {
  const newest = (left: T, right: T) =>
    (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt);
  return {
    threads: chats.filter((chat) => agentChatKind(chat) === "thread").toSorted(newest),
    subagents: chats.filter((chat) => agentChatKind(chat) === "subagent").toSorted(newest),
  };
}

/** "Agents' chats (5)", folded or not. */
export function agentChatsShelfLabel(count: number, expanded: boolean): string {
  return expanded ? "Agents' chats" : `Agents' chats (${count})`;
}

/**
 * The handoff a chat offers the person: Join while an agent handles it, Hand
 * to agent while they do. Not Uno's own chat (it is the assistant's
 * conversation with them), and a chat of the person's own only where the
 * daemon lets them hand it off (`ownChats`, the `chatHandoff` capability).
 */
export function handoffAction(
  thread: Pick<
    TaskSummary,
    "controller" | "assistantRole" | "spawnedByThreadId" | "controlChangedAt"
  >,
  options: { readonly ownChats: boolean } = { ownChats: true },
): {
  readonly label: string;
  readonly hint: string;
  readonly nextController: ThreadController;
} | null {
  if (thread.assistantRole === "chat") return null;
  if (threadHandler(thread) === "agent") {
    return { label: HANDLER_COPY.join, hint: HANDLER_COPY.joinHint, nextController: "human" };
  }
  if (thread.spawnedByThreadId == null && !options.ownChats) return null;
  return {
    label: HANDLER_COPY.handToAgent,
    hint: HANDLER_COPY.handToAgentHint,
    nextController: "agent",
  };
}

/** The person should look at it: the sidebar shows it, marked. */
export function agentTaskNeedsPerson(task: TaskSummary): boolean {
  return agentTaskStatus(task) === "needs-you";
}

export interface AgentTaskRow {
  readonly task: TaskSummary;
  readonly status: AgentTaskStatus;
  readonly kind: AgentChatKind;
  readonly handler: ThreadHandler;
}

/** A chat's live tasks: threads, then subagents; in each the most urgent first, then the newest. */
export function agentTasksOf(
  parentId: ThreadId,
  summaries: Iterable<TaskSummary>,
): ReadonlyArray<AgentTaskRow> {
  const rows: AgentTaskRow[] = [];
  for (const summary of summaries) {
    if (summary.spawnedByThreadId !== parentId || summary.archivedAt !== null) continue;
    rows.push({
      task: summary,
      status: agentTaskStatus(summary),
      kind: agentChatKind(summary),
      handler: threadHandler(summary),
    });
  }
  return rows.toSorted(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === "thread" ? -1 : 1) ||
      STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) ||
      right.task.createdAt.localeCompare(left.task.createdAt),
  );
}

/** "2 threads · 1 subagent · 1 needs you · 1 working" — the strip folded. */
export function agentTasksSummary(rows: ReadonlyArray<AgentTaskRow>): string {
  const counts = new Map<AgentTaskStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const threads = rows.filter((row) => row.kind === "thread").length;
  const subagents = rows.length - threads;
  const parts: string[] = [];
  if (threads > 0) parts.push(`${threads} ${threads === 1 ? "thread" : "threads"}`);
  if (subagents > 0) parts.push(`${subagents} ${subagents === 1 ? "subagent" : "subagents"}`);
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count === undefined) continue;
    // All done: the count says it.
    if (status === "done" && count === rows.length) {
      parts.push("all done");
      continue;
    }
    parts.push(`${count} ${AGENT_TASK_STATUS_LABEL[status].toLowerCase()}`);
  }
  return parts.join(" · ");
}

/**
 * Every live task under a chat, its tasks' tasks too (what archiving the
 * chat archives), nearest first. Safe on a cycle.
 */
export function agentTaskDescendants(
  parentId: ThreadId,
  summaries: Iterable<TaskSummary>,
): ReadonlyArray<TaskSummary> {
  const byParent = new Map<ThreadId, TaskSummary[]>();
  for (const summary of summaries) {
    const parent = summary.spawnedByThreadId;
    if (parent == null || summary.archivedAt !== null) continue;
    const list = byParent.get(parent);
    if (list) list.push(summary);
    else byParent.set(parent, [summary]);
  }
  const out: TaskSummary[] = [];
  const seen = new Set<ThreadId>([parentId]);
  const queue: ThreadId[] = [parentId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** Still going: archiving it stops it, so the person confirms first. */
export function isAgentTaskRunning(task: TaskSummary): boolean {
  const status = agentTaskStatus(task);
  return status === "working" || status === "waiting" || status === "needs-you";
}

/** The confirm before archiving a chat whose tasks still run; null — no need to ask. */
export function archiveWithTasksPrompt(
  title: string,
  tasks: ReadonlyArray<TaskSummary>,
): string | null {
  const running = tasks.filter(isAgentTaskRunning).length;
  if (running === 0) return null;
  return [
    `Archive chat "${title}"?`,
    running === 1
      ? "1 of its agent tasks is still working: it will be stopped and archived too."
      : `${running} of its agent tasks are still working: they will be stopped and archived too.`,
  ].join("\n");
}

function quoted(title: string | null | undefined): string {
  const clean = title?.trim() ?? "";
  return clean.length > 0 ? `“${clean}”` : "";
}

/**
 * The folded line for a task's message in the coordinator's feed. The latest
 * message of a task says where the task is now; earlier ones are updates.
 */
export function agentTaskReportLabel(input: {
  readonly title: string | null | undefined;
  readonly status: AgentTaskStatus | null;
  readonly latest: boolean;
}): string {
  const name = quoted(input.title);
  const task = name ? `Task ${name}` : "A task";
  if (!input.latest || input.status === null)
    return `Update from ${name ? `task ${name}` : "a task"}`;
  switch (input.status) {
    case "done":
      return `${task} is done`;
    case "needs-you":
      return `${task} needs you`;
    case "error":
      return `${task} failed`;
    case "stopped":
      return `${task} stopped`;
    default:
      return `Update from ${name ? `task ${name}` : "a task"}`;
  }
}

/** For each task that wrote here, the id of its latest message (the one that says "done"). */
export function latestReportIdBySender(
  messages: Iterable<{
    readonly id: string;
    readonly role: string;
    readonly sentByThreadId?: ThreadId | null | undefined;
  }>,
): ReadonlyMap<ThreadId, string> {
  const out = new Map<ThreadId, string>();
  for (const message of messages) {
    if (message.role !== "user" || message.sentByThreadId == null) continue;
    out.set(message.sentByThreadId, message.id);
  }
  return out;
}
