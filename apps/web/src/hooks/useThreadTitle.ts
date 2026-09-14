import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { selectEnvironmentState, useStore } from "../store";

/**
 * Title of a thread in the store, or null when it is not loaded (deleted,
 * other environment not synced yet, or no id). Used to name the parent of an
 * agent-spawned thread.
 */
export function useThreadTitle(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): string | null {
  return useStore((state) =>
    environmentId && threadId
      ? (selectEnvironmentState(state, environmentId).threadShellById[threadId]?.title ?? null)
      : null,
  );
}
