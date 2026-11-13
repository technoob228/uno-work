/**
 * A report from one of this chat's agent tasks, folded (Misha 13.11): one
 * centred system line "Task “<name>” is done · Open" that unfolds to what it
 * wrote. The coordinator's agent still gets the whole message (the stored
 * text is unchanged); the person reads the coordinator's answer, not every
 * line its helpers send. A message from any other chat's agent keeps its
 * bubble (`fallback`).
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ListChecksIcon } from "lucide-react";
import { memo, type ReactNode, useState } from "react";

import { agentTaskReportLabel, agentTaskStatus } from "../../agentTasks.logic";
import { cn } from "../../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import ChatMarkdown from "../ChatMarkdown";

export const AgentTaskReportRow = memo(function AgentTaskReportRow(props: {
  readonly environmentId: EnvironmentId;
  /** The open chat's scoped key (MessagesTimeline's routeThreadKey). */
  readonly chatKey: string;
  readonly sentByThreadId: ThreadId;
  readonly text: string;
  /** The task's latest message here: it says where the task is now. */
  readonly latest: boolean;
  readonly markdownCwd: string | undefined;
  readonly fallback: ReactNode;
}) {
  const sender = useStore((state) =>
    selectSidebarThreadSummaryByRef(state, {
      environmentId: props.environmentId,
      threadId: props.sentByThreadId,
    }),
  );
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const parentKey =
    sender?.spawnedByThreadId != null
      ? scopedThreadKey(scopeThreadRef(props.environmentId, sender.spawnedByThreadId))
      : null;
  // Only this chat's own task folds.
  if (sender === undefined || parentKey !== props.chatKey) {
    return <>{props.fallback}</>;
  }
  const status = agentTaskStatus(sender);
  const label = agentTaskReportLabel({ title: sender.title, status, latest: props.latest });
  return (
    <div className="flex flex-col items-center px-4" data-testid="agent-task-report">
      <div
        className={cn(
          "flex max-w-[80%] min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
          expanded && "w-full max-w-208",
        )}
      >
        <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-info" />
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <span aria-hidden className="shrink-0 text-muted-foreground/60">
          ·
        </span>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: props.environmentId, threadId: props.sentByThreadId },
            })
          }
          className="shrink-0 cursor-pointer rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="agent-task-report-open"
        >
          Open
        </button>
        <span aria-hidden className="shrink-0 text-muted-foreground/60">
          ·
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="agent-task-report-toggle"
        >
          {expanded ? "Hide" : "Show"}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </div>
      {expanded ? (
        <div
          className="mt-1.5 w-full max-w-208 rounded-xl border border-dashed border-info/30 bg-info/4 px-3.5 py-2 text-sm"
          data-testid="agent-task-report-body"
          data-thread-find-text
        >
          <ChatMarkdown
            text={props.text}
            cwd={props.markdownCwd}
            isStreaming={false}
            environmentId={props.environmentId}
          />
        </div>
      ) : null}
    </div>
  );
});
