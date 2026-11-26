import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` understands `thread.handler.set`
 * ("Hand to…" another chat or an assistant, T63, 0.0.195). Older daemons do
 * not advertise `chatHandTo`: the app keeps Hand to agent / Join there.
 */
export function descriptorSupportsHandTo(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.chatHandTo === true;
}

export function readEnvironmentSupportsHandTo(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsHandTo(primary);
  }
  return descriptorSupportsHandTo(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

export function useEnvironmentSupportsHandTo(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? descriptorSupportsHandTo(state.byId[environmentId]?.descriptor) : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsHandTo(primary);
  }
  return saved;
}
