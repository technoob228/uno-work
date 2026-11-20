import type { EnvironmentId, ThreadController, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, LockIcon, UserRoundIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import {
  resolveThreadControlBarState,
  type ThreadControlBarAction,
} from "../../agentThreads.logic";
import { setThreadAgentsClosed, setThreadHandler } from "../../agentsAccess";
import { useEnvironmentSupportsAgentsCloseChat } from "../../environments/agentsCloseChatSupport";
import { useEnvironmentSupportsAgentThreads } from "../../environments/agentThreadsSupport";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import { cn } from "../../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { threadOwner } from "../Sidebar.owner";
import { Button } from "../ui/button";

interface ThreadControlBarProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly spawnedByThreadId: ThreadId | null | undefined;
  readonly controller: ThreadController | null | undefined;
  readonly agentsClosedAt: string | null | undefined;
  readonly className?: string;
}

/**
 * Slim strip above the composer: who started a chat another chat's agent
 * created and who handles it now — Join / Hand to agent (Misha 14.11); a
 * chat the person handed to its agent, with Join; in the person's own chat,
 * that agents talk there now; and the "Don't let agents write here" switch. A
 * chat closed to agents shows the strip whoever created it, so the switch is
 * always one click away from where it is visible. The composer stays enabled
 * either way.
 */
export const ThreadControlBar = memo(function ThreadControlBar({
  environmentId,
  threadId,
  spawnedByThreadId,
  controller,
  agentsClosedAt,
  className,
}: ThreadControlBarProps) {
  const supported = useEnvironmentSupportsAgentThreads(environmentId);
  const supportsAgentsAccess = useEnvironmentSupportsAgentsCloseChat(environmentId);
  const parentTitle = useThreadTitle(environmentId, spawnedByThreadId);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const agentLed = useStore((store) => {
    const summary = selectSidebarThreadSummaryByRef(store, { environmentId, threadId });
    return summary !== undefined && threadOwner(summary) === "agent";
  });
  const state = resolveThreadControlBarState({
    spawnedByThreadId,
    controller,
    parentTitle,
    agentsClosedAt,
    supportsAgentsAccess,
    agentLed,
  });

  const runAction = useCallback(
    async (action: ThreadControlBarAction) => {
      setPending(true);
      try {
        if (action.kind === "agents-access") {
          await setThreadAgentsClosed({ environmentId, threadId, closed: action.nextClosed });
          return;
        }
        // Join / Hand to agent (and an older daemon's Take over / Hand back).
        await setThreadHandler({ environmentId, threadId, controller: action.nextController });
      } finally {
        setPending(false);
      }
    },
    [environmentId, threadId],
  );

  const openParent = useCallback(() => {
    if (!spawnedByThreadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: spawnedByThreadId },
    });
  }, [environmentId, navigate, spawnedByThreadId]);

  if (!supported || !state) {
    return null;
  }

  const agentDriving =
    !state.closedToAgents && state.controller === "agent" && (!!spawnedByThreadId || agentLed);
  const Icon = state.closedToAgents ? LockIcon : agentDriving ? BotIcon : UserRoundIcon;

  return (
    <div
      role="status"
      data-testid="thread-control-bar"
      data-controller={state.controller}
      data-agents-closed={state.closedToAgents ? "true" : undefined}
      className={cn(
        "mx-auto mb-2 flex max-w-208 items-center gap-2 rounded-lg border px-2.5 py-1 text-xs",
        agentDriving
          ? "border-info/30 bg-info/8 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", agentDriving ? "text-info" : "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1 truncate" title={state.summary}>
        {state.leadText}
        {state.parentLinkText ? (
          <button
            type="button"
            onClick={openParent}
            title="Open the chat that created this one"
            className="cursor-pointer rounded-sm font-medium text-foreground underline-offset-2 outline-hidden hover:underline focus-visible:ring-1 focus-visible:ring-ring"
          >
            {state.parentLinkText}
          </button>
        ) : null}
        {state.trailText}
      </span>
      {state.secondaryAction ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (state.secondaryAction) void runAction(state.secondaryAction);
          }}
          data-testid="thread-control-secondary-action"
          className="shrink-0 text-muted-foreground"
        >
          {state.secondaryAction.label}
        </Button>
      ) : null}
      {state.action ? (
        <Button
          size="xs"
          variant={state.closedToAgents || state.action.kind === "handoff" ? "outline" : "ghost"}
          disabled={pending}
          {...(state.action.kind === "handoff" && state.action.hint
            ? { title: state.action.hint }
            : {})}
          onClick={() => {
            if (state.action) void runAction(state.action);
          }}
          data-testid="thread-control-action"
          className="shrink-0"
        >
          {state.action.label}
        </Button>
      ) : null}
    </div>
  );
});
