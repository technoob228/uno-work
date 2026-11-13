// Agent tasks (Misha 13.11): the chats a chat's agent started live inside that
// chat — its "Tasks" strip — instead of the person's sidebar and feed.
// - A task is a chat whose `spawnedByThreadId` names a live regular chat (not
//   Uno's: its chats keep their own place under the Uno row).
// - The sidebar hides tasks unless the person wants them ("Agents' tasks" in
//   the view menu), one needs the person (a question, an approval, a call, an
//   answer to their own message), they brought it up (pinned) or it is open.
// - The coordinator's feed folds a task's report into one line.
// - Archiving the coordinator archives its tasks (and theirs).
// Pure, so the sidebar, the strip and the feed say the same thing.
import type { ThreadId } from "@t3tools/contracts";

import { isRegularListChat } from "./assistant/assistantChat.logic";
import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";
import { isPersonCallPending, threadOwner } from "./components/Sidebar.owner";
import { threadNeedsUser } from "./components/Sidebar.snooze";
import type { SidebarThreadSummary } from "./types";

/** The person's "Agents' tasks" switch in the sidebar's view menu (this device). Off by default. */
export const SIDEBAR_SHOW_AGENT_TASKS_KEY = "uno-work:sidebar:show-agent-tasks";

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
 * The sidebar hides a task (see the top of the file). `parent` is the chat
 * named by `spawnedByThreadId`, in the same environment.
 */
export function isHiddenAgentTask(input: {
  readonly thread: TaskSummary;
  readonly parent: TaskSummary | undefined;
  readonly assistantChatId: string | null;
  readonly showAgentTasks: boolean;
  readonly isOpen: boolean;
}): boolean {
  if (input.showAgentTasks || input.isOpen) return false;
  if (!isAgentTask(input.thread, input.parent, input.assistantChatId)) return false;
  // "Move to sidebar" pins it: the person's own chat from then on.
  if (input.thread.pinnedAt !== null) return false;
  return threadOwner(input.thread) !== "you";
}

/** The person should look at it: the sidebar shows it, marked. */
export function agentTaskNeedsPerson(task: TaskSummary): boolean {
  return agentTaskStatus(task) === "needs-you";
}

export interface AgentTaskRow {
  readonly task: TaskSummary;
  readonly status: AgentTaskStatus;
}

/** A chat's live tasks, most urgent first, then the newest. */
export function agentTasksOf(
  parentId: ThreadId,
  summaries: Iterable<TaskSummary>,
): ReadonlyArray<AgentTaskRow> {
  const rows: AgentTaskRow[] = [];
  for (const summary of summaries) {
    if (summary.spawnedByThreadId !== parentId || summary.archivedAt !== null) continue;
    rows.push({ task: summary, status: agentTaskStatus(summary) });
  }
  return rows.toSorted(
    (left, right) =>
      STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) ||
      right.task.createdAt.localeCompare(left.task.createdAt),
  );
}

/** "3 tasks · 1 needs you · 1 working" — the strip folded. */
export function agentTasksSummary(rows: ReadonlyArray<AgentTaskRow>): string {
  const counts = new Map<AgentTaskStatus, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const parts = [`${rows.length} ${rows.length === 1 ? "task" : "tasks"}`];
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
