import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
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

/** Non-hook read (menus): whether the daemon tracks agent-spawned threads. */
export function readEnvironmentSupportsAgentThreads(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) return descriptorSupportsAgentThreads(primary);
  return descriptorSupportsAgentThreads(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

/**
 * Whether the person may hand a chat of theirs to its agent there (Misha
 * 14.11, `chatHandoff`). Joining a chat an agent started works on any daemon
 * with `agentThreads`.
 */
export function readEnvironmentSupportsChatHandoff(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  const descriptor =
    primary?.environmentId === environmentId
      ? primary
      : useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor;
  return descriptor?.capabilities.chatHandoff === true;
}
