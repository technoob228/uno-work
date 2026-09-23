/**
 * React Query wiring for "What's using your computer". Everything is read by
 * the daemon of this environment from its own OS (`uno.computer.resources`,
 * `uno.computer.diskUsage`); nothing goes to the control plane.
 */
import type {
  EnvironmentId,
  UnoDiskCleanInput,
  UnoDiskUsage,
  UnoResourceActionInput,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { computerQueryKeys } from "../computerQueries";

const RESOURCES_REFETCH_MS = 3_000;
/** While `du` runs, ask again soon; once measured, rarely (the daemon caches it). */
const DISK_SCANNING_REFETCH_MS = 2_000;
const DISK_REFETCH_MS = 60_000;

export const resourceQueryKeys = {
  resources: (environmentId: EnvironmentId | null) =>
    ["uno-computer", "resources", environmentId] as const,
  disk: (environmentId: EnvironmentId | null, path: string | null) =>
    ["uno-computer", "disk", environmentId, path] as const,
  diskAll: (environmentId: EnvironmentId | null) =>
    ["uno-computer", "disk", environmentId] as const,
};

function api(environmentId: EnvironmentId | null) {
  if (environmentId === null) throw new Error("No connection to this computer.");
  return ensureEnvironmentApi(environmentId).unoComputer;
}

export function resourcesQueryOptions(environmentId: EnvironmentId | null, enabled = true) {
  return queryOptions({
    queryKey: resourceQueryKeys.resources(environmentId),
    queryFn: () => api(environmentId).resources(),
    enabled: environmentId !== null && enabled,
    refetchInterval: RESOURCES_REFETCH_MS,
  });
}

export function diskUsageQueryOptions(
  environmentId: EnvironmentId | null,
  path: string | null,
  enabled = true,
) {
  return queryOptions({
    queryKey: resourceQueryKeys.disk(environmentId, path),
    queryFn: () => api(environmentId).diskUsage(path ? { path } : {}),
    enabled: environmentId !== null && enabled,
    refetchInterval: (query) =>
      (query.state.data as UnoDiskUsage | undefined)?.scanning
        ? DISK_SCANNING_REFETCH_MS
        : DISK_REFETCH_MS,
  });
}

export function rescanDisk(
  environmentId: EnvironmentId | null,
  path: string | null,
  queryClient: QueryClient,
) {
  return api(environmentId)
    .diskUsage({ ...(path ? { path } : {}), rescan: true })
    .then((data) => queryClient.setQueryData(resourceQueryKeys.disk(environmentId, path), data));
}

export function resourceActionMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "resource-action", environmentId] as const,
    mutationFn: (input: UnoResourceActionInput) => api(environmentId).resourceAction(input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: resourceQueryKeys.resources(environmentId) });
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.machineApps(environmentId),
      });
    },
  });
}

export function diskCleanMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "disk-clean", environmentId] as const,
    mutationFn: (input: UnoDiskCleanInput) => api(environmentId).diskClean(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: resourceQueryKeys.diskAll(environmentId) });
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.localMetrics(environmentId),
      });
    },
  });
}
