import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` tracks agent-spawned threads
 * (spawnedByThreadId, controller, thread.control.set). Older daemons do not
 * advertise `agentThreads`, so the bot badge, control bar and the
 * cross-project setting stay hidden for them instead of failing on click.
 */
export function descriptorSupportsAgentThreads(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.agentThreads === true;
}

export function useEnvironmentSupportsAgentThreads(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? descriptorSupportsAgentThreads(state.byId[environmentId]?.descriptor) : false,
  );
  if (!environmentId) {
    return false;
  }
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsAgentThreads(primary);
  }
  return saved;
}
