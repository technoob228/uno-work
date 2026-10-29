import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` cleans chat copies (worktrees)
 * itself (0.0.157): `storageCleanup` settings, the cleanup RPCs, and the copy
 * of a deleted chat removed on the server. Older daemons do not advertise
 * `worktreeCleanup`: the settings stay hidden and deleting a chat still asks
 * "Delete the worktree too?".
 */
export function descriptorSupportsWorktreeCleanup(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.worktreeCleanup === true;
}

export function readEnvironmentSupportsWorktreeCleanup(environmentId: EnvironmentId): boolean {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsWorktreeCleanup(primary);
  }
  return descriptorSupportsWorktreeCleanup(
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor,
  );
}

export function useEnvironmentSupportsWorktreeCleanup(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId
      ? descriptorSupportsWorktreeCleanup(state.byId[environmentId]?.descriptor)
      : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) return descriptorSupportsWorktreeCleanup(primary);
  return saved;
}
