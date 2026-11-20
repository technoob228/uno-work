import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CirclePauseIcon,
  ChevronDownIcon,
  HourglassIcon,
  ListChecksIcon,
  UserRoundIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  AGENT_CHAT_KIND_LABEL,
  AGENT_TASK_STATUS_LABEL,
  agentTasksOf,
  agentTasksSummary,
  handoffAction,
  type AgentTaskStatus,
} from "../../agentTasks.logic";
import { setThreadHandler } from "../../agentsAccess";
import { useEnvironmentSupportsAgentThreads } from "../../environments/agentThreadsSupport";
import { cn } from "../../lib/utils";
import { selectEnvironmentState, useStore } from "../../store";
import { Spinner } from "../ui/spinner";

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
 * (Misha 13.11, after T3's Lineage panel; v2 14.11): its threads and its
 * subagents apart, each with where it stands; a click opens it, "Join" makes
 * it the person's chat (in their sidebar), "Hand to agent" gives it back.
 * Chats an agent handles stay out of the sidebar's list (agentTasks.logic).
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
  const groups = useMemo(
    () =>
      (["thread", "subagent"] as const)
        .map((kind) => ({ kind, rows: rows.filter((row) => row.kind === kind) }))
        .filter((group) => group.rows.length > 0),
    [rows],
  );
  const needsYou = rows.some((row) => row.status === "needs-you");
  // Open by itself when a task waits on the person; else one quiet line.
  const [expandedChoice, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedChoice ?? needsYou;
  const navigate = useNavigate();

  if (!supported || rows.length === 0) return null;

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
        <div className="max-h-56 overflow-y-auto border-t border-border/60 py-1">
          {groups.map((group) => (
            <section key={group.kind} data-testid={`agent-tasks-group-${group.kind}`}>
              {/* The two kinds apart (Misha 14.11); one kind needs no heading. */}
              {groups.length > 1 ? (
                <h3 className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
                  {AGENT_CHAT_KIND_LABEL[group.kind]}
                </h3>
              ) : null}
              <ul role="list">
                {group.rows.map(({ task, status, handler }) => {
                  const handoff = handoffAction(task);
                  return (
                    <li
                      key={task.id}
                      className="group/task flex min-w-0 items-center gap-2 px-2.5 py-0.5"
                      data-testid="agent-task-row"
                      data-status={status}
                      data-handler={handler}
                    >
                      <StatusIcon status={status} />
                      <button
                        type="button"
                        title="Open this chat"
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
                      {handler === "you" ? (
                        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                          <UserRoundIcon aria-hidden className="size-3" />
                          You're on it
                        </span>
                      ) : null}
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
                      {handoff ? (
                        <button
                          type="button"
                          onClick={() =>
                            void setThreadHandler({
                              environmentId,
                              threadId: task.id,
                              controller: handoff.nextController,
                            })
                          }
                          title={handoff.hint}
                          aria-label={`${handoff.label}: ${task.title}`}
                          className="shrink-0 cursor-pointer rounded-sm px-1 text-muted-foreground opacity-70 outline-hidden group-hover/task:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                          data-testid="agent-task-handoff"
                        >
                          {handoff.label}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
});
