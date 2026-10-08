import type { EnvironmentId, ThreadController, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, LockIcon, UserRoundIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { resolveThreadControlBarState } from "../../agentThreads.logic";
import { setThreadAgentsClosed } from "../../agentsAccess";
import { readEnvironmentApi } from "../../environmentApi";
import { useEnvironmentSupportsAgentsCloseChat } from "../../environments/agentsCloseChatSupport";
import { useEnvironmentSupportsAgentThreads } from "../../environments/agentThreadsSupport";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import { cn, newCommandId } from "../../lib/utils";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface ThreadControlBarProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly spawnedByThreadId: ThreadId | null | undefined;
  readonly controller: ThreadController | null | undefined;
  readonly agentsClosedAt: string | null | undefined;
  readonly className?: string;
}

/**
 * Slim strip above the composer: who started / drives a chat another chat's
 * agent created, and the person's "Don't let agents write here" switch. A
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
  const state = resolveThreadControlBarState({
    spawnedByThreadId,
    controller,
    parentTitle,
    agentsClosedAt,
    supportsAgentsAccess,
  });

  const action = state?.action ?? null;
  const handleAction = useCallback(async () => {
    if (!action) return;
    setPending(true);
    try {
      if (action.kind === "agents-access") {
        await setThreadAgentsClosed({ environmentId, threadId, closed: action.nextClosed });
        return;
      }
      // Older daemon: the old handoff pair.
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "thread.control.set",
        commandId: newCommandId(),
        threadId,
        controller: action.nextController,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${action.label.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setPending(false);
    }
  }, [action, environmentId, threadId]);

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

  const agentDriving = !state.closedToAgents && state.controller === "agent" && !!spawnedByThreadId;
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
      {action ? (
        <Button
          size="xs"
          variant={state.closedToAgents ? "outline" : "ghost"}
          disabled={pending}
          onClick={() => void handleAction()}
          data-testid="thread-control-action"
          className="shrink-0"
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
});
