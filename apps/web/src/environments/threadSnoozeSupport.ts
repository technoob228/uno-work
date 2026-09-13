import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` understands thread.snooze /
 * thread.unsnooze. Older daemons do not advertise `threadSnooze`, so the
 * Snooze actions stay hidden for their chats instead of failing on click.
 */
export function descriptorSupportsThreadSnooze(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.threadSnooze === true;
}

export function readEnvironmentSupportsThreadSnooze(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsThreadSnooze(primary);
  }
  return descriptorSupportsThreadSnooze(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

export function useEnvironmentSupportsThreadSnooze(environmentId: EnvironmentId): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    descriptorSupportsThreadSnooze(state.byId[environmentId]?.descriptor),
  );
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsThreadSnooze(primary);
  }
  return saved;
}
