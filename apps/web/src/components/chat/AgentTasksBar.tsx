import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpToLineIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CirclePauseIcon,
  ChevronDownIcon,
  HourglassIcon,
  ListChecksIcon,
  PinOffIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  AGENT_TASK_STATUS_LABEL,
  agentTasksOf,
  agentTasksSummary,
  type AgentTaskStatus,
} from "../../agentTasks.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { useEnvironmentSupportsAgentThreads } from "../../environments/agentThreadsSupport";
import { cn, newCommandId } from "../../lib/utils";
import { selectEnvironmentState, useStore } from "../../store";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

function StatusIcon({ status }: { status: AgentTaskStatus }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "needs-you":
      return <CircleDotIcon aria-hidden className={cn(className, "text-warning")} />;
    case "working":
      return <Spinner aria-hidden className={cn(className, "text-info")} />;
    case "waiting":
      return <HourglassIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "error":
      return <CircleAlertIcon aria-hidden className={cn(className, "text-destructive")} />;
    case "stopped":
      return <CirclePauseIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(className, "text-success")} />;
  }
}

/**
 * "Tasks" above the composer of a chat whose agent started other chats
 * (Misha 13.11, after T3's Lineage panel): each task with where it stands,
 * a click opens it, and "Move to sidebar" makes it one of the person's chats
 * (pinned; "Back to tasks" unpins). The tasks themselves stay out of the
 * sidebar until they need the person (agentTasks.logic).
 */
export const AgentTasksBar = memo(function AgentTasksBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const supported = useEnvironmentSupportsAgentThreads(environmentId);
  const summaries = useStore(
    (state) => selectEnvironmentState(state, environmentId).sidebarThreadSummaryById,
  );
  const rows = useMemo(
    () => agentTasksOf(threadId, Object.values(summaries)),
    [summaries, threadId],
  );
  const needsYou = rows.some((row) => row.status === "needs-you");
  // Open by itself when a task waits on the person; else one quiet line.
  const [expandedChoice, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? needsYou;
  const navigate = useNavigate();

  if (!supported || rows.length === 0) return null;

  const setPinned = async (taskId: ThreadId, pinned: boolean) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: taskId,
        pinnedAt: pinned ? new Date().toISOString() : null,
      });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: pinned ? "Moved to the sidebar" : "Back in this chat's tasks",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Could not move the task to the sidebar" : "Could not move the task back",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <div
      data-testid="agent-tasks-bar"
      data-expanded={expanded ? "true" : undefined}
      className={cn(
        "mx-auto mb-2 max-w-208 rounded-lg border text-xs",
        needsYou ? "border-warning/40 bg-warning/6" : "border-border bg-muted/40",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="agent-tasks-toggle"
      >
        <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {agentTasksSummary(rows)}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <ul className="max-h-48 overflow-y-auto border-t border-border/60 py-1" role="list">
          {rows.map(({ task, status }) => {
            const pinned = task.pinnedAt !== null;
            return (
              <li
                key={task.id}
                className="group/task flex min-w-0 items-center gap-2 px-2.5 py-0.5"
                data-testid="agent-task-row"
                data-status={status}
              >
                <StatusIcon status={status} />
                <button
                  type="button"
                  title="Open this task"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: task.id },
                    })
                  }
                  className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-foreground underline-offset-2 outline-hidden hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {task.title}
                </button>
                <span
                  className={cn(
                    "shrink-0",
                    status === "needs-you"
                      ? "font-medium text-warning"
                      : status === "error"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {AGENT_TASK_STATUS_LABEL[status]}
                </span>
                <button
                  type="button"
                  onClick={() => void setPinned(task.id, !pinned)}
                  title={
                    pinned
                      ? "Back to tasks: out of the sidebar again"
                      : "Move to sidebar: a chat of yours, pinned on top"
                  }
                  aria-label={
                    pinned ? `Back to tasks: ${task.title}` : `Move to sidebar: ${task.title}`
                  }
                  className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-60 outline-hidden group-hover/task:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                  data-testid="agent-task-move"
                >
                  {pinned ? (
                    <PinOffIcon aria-hidden className="size-3" />
                  ) : (
                    <ArrowUpToLineIcon aria-hidden className="size-3" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
});
