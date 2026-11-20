// The feed's pieces for messages other chats' agents send here: who sent one
// (0.0.115) and which of them is a task's latest report (T46, Misha 13.11).
// Out of MessagesTimeline.tsx to keep it under the 2000-line lint limit.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { latestReportIdBySender } from "~/agentTasks.logic";
import { describeAgentSentMessage } from "~/agentThreads.logic";
import { useThreadTitle } from "~/hooks/useThreadTitle";
import type { deriveTimelineEntries } from "../../session-logic";

/**
 * Each agent task's latest message in the feed (agentTasks.logic): it says
 * "done". Keyed by value: a streaming chunk must not change the context.
 */
export function useLatestTaskReportIds(
  timelineEntries: ReturnType<typeof deriveTimelineEntries>,
): ReadonlySet<string> {
  const latestTaskReportKey = useMemo(
    () =>
      [
        ...latestReportIdBySender(
          timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
        ).values(),
      ].join("\n"),
    [timelineEntries],
  );
  return useMemo(() => new Set(latestTaskReportKey.split("\n")), [latestTaskReportKey]);
}

/** "From the agent in “<thread>”" above a user message another chat's agent sent. */
export const AgentSentMessageLabel = memo(function AgentSentMessageLabel({
  environmentId,
  sentByThreadId,
}: {
  environmentId: EnvironmentId;
  sentByThreadId: ThreadId;
}) {
  const senderTitle = useThreadTitle(environmentId, sentByThreadId);
  const navigate = useNavigate();
  const label = describeAgentSentMessage(senderTitle);
  return (
    <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
      <BotIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
      {senderTitle ? (
        <button
          type="button"
          title="Open the chat this message came from"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: sentByThreadId },
            })
          }
          className="cursor-pointer truncate rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        >
          {label}
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </div>
  );
});
