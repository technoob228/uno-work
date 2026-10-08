import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AGENTS_ACCESS_COPY } from "./agentThreads.logic";
import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";
import { stackedThreadToast, toastManager } from "./components/ui/toast";

/**
 * "Don't let agents write here" / "Let agents write here" for one chat: the
 * person's switch, stored as `agentsClosedAt` in the chat's events (it
 * survives restarts). Shared by the chat menu and the strip above the
 * composer. Resolves true when the daemon took it.
 */
export async function setThreadAgentsClosed(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly closed: boolean;
}): Promise<boolean> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return false;
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      agentsClosedAt: input.closed ? new Date().toISOString() : null,
    });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: input.closed ? AGENTS_ACCESS_COPY.closedToast : AGENTS_ACCESS_COPY.openedToast,
      }),
    );
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: AGENTS_ACCESS_COPY.failed,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
}
