import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` understands thread.settle /
 * thread.unsettle. Older daemons do not advertise `threadSettlement`, so the
 * Settle / Un-settle actions stay hidden for their chats instead of failing on click.
 */
export function descriptorSupportsThreadSettlement(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.threadSettlement === true;
}

export function readEnvironmentSupportsThreadSettlement(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsThreadSettlement(primary);
  }
  return descriptorSupportsThreadSettlement(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

export function useEnvironmentSupportsThreadSettlement(environmentId: EnvironmentId): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    descriptorSupportsThreadSettlement(state.byId[environmentId]?.descriptor),
  );
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsThreadSettlement(primary);
  }
  return saved;
}
