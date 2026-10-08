import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` has "Don't let agents write
 * here" (thread.meta.update `agentsClosedAt`, 0.0.115) — and with it the
 * rule that a human having written in a chat no longer locks agents out.
 * Older daemons do not advertise `agentsCloseChat`: the switch stays hidden
 * and the control bar keeps their take-over / hand-back pair.
 */
export function descriptorSupportsAgentsCloseChat(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.agentsCloseChat === true;
}

export function readEnvironmentSupportsAgentsCloseChat(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsAgentsCloseChat(primary);
  }
  return descriptorSupportsAgentsCloseChat(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

export function useEnvironmentSupportsAgentsCloseChat(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId
      ? descriptorSupportsAgentsCloseChat(state.byId[environmentId]?.descriptor)
      : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsAgentsCloseChat(primary);
  }
  return saved;
}
