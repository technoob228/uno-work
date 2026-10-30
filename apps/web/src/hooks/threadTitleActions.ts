import type { ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";

/** "Regenerate title" in a chat's menu: a new title from the conversation so far. */
export async function regenerateThreadTitle(threadRef: ScopedThreadRef): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) {
    toastManager.add(
      stackedThreadToast({ type: "error", title: "That computer is offline. Try again later." }),
    );
    return;
  }
  const pending = toastManager.add(stackedThreadToast({ type: "info", title: "Making a title…" }));
  try {
    await api.orchestration.regenerateThreadTitle({ threadId: threadRef.threadId });
    toastManager.close(pending);
  } catch (error) {
    toastManager.close(pending);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn't make a new title",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  }
}
