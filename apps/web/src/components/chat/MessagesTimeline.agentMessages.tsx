// The feed's pieces for messages other chats' agents send here: who sent one
// (0.0.115), which of them is a task's latest report (T46, Misha 13.11), and
// each run of their talk folded to one line (T63, Misha 24.11).
// Out of MessagesTimeline.tsx to keep it under the 2000-line lint limit.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { latestReportIdBySender } from "~/agentTasks.logic";
import { describeAgentSentMessage } from "~/agentThreads.logic";
import { useEnvironmentIdByBoxId } from "~/hooks/useHandToComputers";
import { useThreadTitle } from "~/hooks/useThreadTitle";
import type { deriveTimelineEntries, TimelineEntry } from "../../session-logic";
import { selectEnvironmentState, useStore } from "../../store";
import { agentTalkRunIdOf, deriveAgentTalkRuns } from "./MessagesTimeline.logic";

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
  const localTitle = useThreadTitle(environmentId, sentByThreadId);
  // Not a chat here: the handler of a chat here, on another computer (T63-C).
  const remoteHandler = useStore((state) =>
    localTitle !== null
      ? null
      : (Object.values(selectEnvironmentState(state, environmentId).sidebarThreadSummaryById).find(
          (thread) => thread?.handler?.threadId === sentByThreadId && thread.handler.computer,
        )?.handler ?? null),
  );
  const environmentIdByBoxId = useEnvironmentIdByBoxId();
  const senderEnvironmentId = remoteHandler?.computer
    ? (environmentIdByBoxId.get(remoteHandler.computer.boxId) ?? null)
    : environmentId;
  const remoteTitle = useThreadTitle(
    remoteHandler ? senderEnvironmentId : null,
    remoteHandler ? sentByThreadId : null,
  );
  const senderTitle = localTitle ?? remoteTitle ?? remoteHandler?.title ?? null;
  const navigate = useNavigate();
  const label = describeAgentSentMessage(senderTitle, remoteHandler?.computer?.name);
  return (
    <div className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
      <BotIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
      {senderTitle && senderEnvironmentId !== null ? (
        <button
          type="button"
          title="Open the chat this message came from"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: senderEnvironmentId, threadId: sentByThreadId },
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

/**
 * Quiet agents (T63): which runs of agents' talk are open. "All open" is
 * what "Waiting for you" asks for when it jumps into the talk; closing one
 * run then keeps the others open.
 */
export function useAgentTalkRuns(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly pendingMarks: ReadonlyMap<string, "waiting" | "replaced">;
  readonly onDisclosureToggle: () => void;
}) {
  const { timelineEntries, pendingMarks, onDisclosureToggle } = input;
  const [agentTalkExpanded, setAgentTalkExpanded] = useState(false);
  const [expandedAgentRunIds, setExpandedAgentRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // What waits for the person never folds away with the agents' talk.
  const keepInSightEntryIds = useMemo(
    () =>
      new Set(
        [...pendingMarks].flatMap(([entryId, mark]) => (mark === "waiting" ? [entryId] : [])),
      ),
    [pendingMarks],
  );
  const latestRef = useRef({ timelineEntries, keepInSightEntryIds, agentTalkExpanded });
  latestRef.current = { timelineEntries, keepInSightEntryIds, agentTalkExpanded };
  const onToggleAgentTalk = useCallback(
    (runId: string) => {
      onDisclosureToggle();
      const latest = latestRef.current;
      if (latest.agentTalkExpanded) {
        setAgentTalkExpanded(false);
        const runs = deriveAgentTalkRuns(latest.timelineEntries, latest.keepInSightEntryIds);
        setExpandedAgentRunIds(new Set(runs.map((run) => run.id).filter((id) => id !== runId)));
        return;
      }
      setExpandedAgentRunIds((current) => {
        const next = new Set(current);
        if (next.has(runId)) next.delete(runId);
        else next.add(runId);
        return next;
      });
    },
    [onDisclosureToggle],
  );
  /** Find opens the run a match hides in. */
  const openAgentTalkAround = useCallback((entryId: string) => {
    const runId = agentTalkRunIdOf(latestRef.current.timelineEntries, entryId);
    if (runId) setExpandedAgentRunIds((current) => new Set(current).add(runId));
  }, []);
  return {
    agentTalkExpanded,
    setAgentTalkExpanded,
    expandedAgentRunIds,
    keepInSightEntryIds,
    onToggleAgentTalk,
    openAgentTalkAround,
  };
}

/** "Agents talked · 6 messages · Release checks, Hero banners · Show" (T63). */
export const AgentTalkFoldRow = memo(function AgentTalkFoldRow(props: {
  environmentId: EnvironmentId;
  runId: string;
  agentMessageCount: number;
  expanded: boolean;
  senderThreadIds: ReadonlyArray<string>;
  onToggle: (runId: string) => void;
}) {
  const { environmentId, senderThreadIds } = props;
  const shells = useStore((state) => selectEnvironmentState(state, environmentId).threadShellById);
  const names = useMemo(
    () =>
      senderThreadIds.map(
        (threadId) => shells[threadId as ThreadId]?.title?.trim() || "another chat",
      ),
    [senderThreadIds, shells],
  );
  const count = props.agentMessageCount;
  const ToggleIcon = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="mx-1 flex justify-center pb-4" data-testid="agent-talk-fold">
      <button
        type="button"
        data-scroll-anchor-ignore
        aria-expanded={props.expanded}
        title={names.length > 0 ? `Agents of ${names.join(", ")} talked here` : undefined}
        className="group/fold flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors outline-hidden hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => props.onToggle(props.runId)}
      >
        <BotIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground/80">Agents talked</span>
        <span aria-hidden className="shrink-0 text-muted-foreground/60">
          ·
        </span>
        <span className="shrink-0" data-testid="agent-talk-fold-count">
          {count} {count === 1 ? "message" : "messages"}
        </span>
        {names.length > 0 ? (
          <>
            <span aria-hidden className="shrink-0 text-muted-foreground/60">
              ·
            </span>
            <span className="min-w-0 truncate">{names.join(", ")}</span>
          </>
        ) : null}
        <span className="ml-1 shrink-0">{props.expanded ? "Hide" : "Show"}</span>
        <ToggleIcon
          aria-hidden
          className="size-3 shrink-0 opacity-60 group-hover/fold:opacity-100"
        />
      </button>
    </div>
  );
});
