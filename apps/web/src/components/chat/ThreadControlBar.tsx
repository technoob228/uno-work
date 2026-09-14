import type { EnvironmentId, ThreadController, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, UserRoundIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { resolveThreadControlBarState } from "../../agentThreads.logic";
import { readEnvironmentApi } from "../../environmentApi";
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
  readonly className?: string;
}

/**
 * Slim strip above the composer of a thread another chat's agent created:
 * who drives it right now and a handoff button. The composer stays enabled
 * either way — a human message takes control server-side on its own.
 */
export const ThreadControlBar = memo(function ThreadControlBar({
  environmentId,
  threadId,
  spawnedByThreadId,
  controller,
  className,
}: ThreadControlBarProps) {
  const supported = useEnvironmentSupportsAgentThreads(environmentId);
  const parentTitle = useThreadTitle(environmentId, spawnedByThreadId);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const state = resolveThreadControlBarState({ spawnedByThreadId, controller, parentTitle });

  const nextController = state?.nextController ?? null;
  const handleAction = useCallback(async () => {
    if (!nextController) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    setPending(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.control.set",
        commandId: newCommandId(),
        threadId,
        controller: nextController,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            nextController === "human" ? "Could not take over" : "Could not hand back to agent",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setPending(false);
    }
  }, [environmentId, nextController, threadId]);

  const openParent = useCallback(() => {
    if (!spawnedByThreadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: spawnedByThreadId },
    });
  }, [environmentId, navigate, spawnedByThreadId]);

  if (!supported || !state || !spawnedByThreadId) {
    return null;
  }

  const agentDriving = state.controller === "agent";
  const Icon = agentDriving ? BotIcon : UserRoundIcon;

  return (
    <div
      role="status"
      data-testid="thread-control-bar"
      data-controller={state.controller}
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
      <Button
        size="xs"
        variant={agentDriving ? "default" : "outline"}
        disabled={pending}
        onClick={() => void handleAction()}
        data-testid="thread-control-action"
      >
        {state.actionLabel}
      </Button>
    </div>
  );
});
