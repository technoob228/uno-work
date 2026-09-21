/**
 * React Query wiring for "This computer". Every call goes to the daemon of the
 * environment the screen is looking at (`uno.computer.*`), which proxies to the
 * Uno control plane with its own account key.
 *
 * Polling is shaped by what a section can show: the monitor refreshes every
 * few seconds while it has live data, and stops asking once the daemon says the
 * route is not there yet ("coming soon") — no point hammering a 404.
 */
import type {
  EnvironmentId,
  UnoComputerApps,
  UnoComputerMetrics,
  UnoComputerPowerInput,
  UnoComputerState,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../../environmentApi";

const STATE_REFETCH_MS = 15_000;
const METRICS_REFETCH_MS = 5_000;
const ACTIVITY_REFETCH_MS = 10_000;
const APPS_REFETCH_MS = 30_000;
/** How long a "coming soon" answer is trusted before asking again. */
const UNAVAILABLE_RECHECK_MS = 5 * 60_000;

export const computerQueryKeys = {
  all: ["uno-computer"] as const,
  state: (environmentId: EnvironmentId | null, boxId: number | null) =>
    ["uno-computer", "state", environmentId, boxId] as const,
  metrics: (environmentId: EnvironmentId | null, boxId: number | null) =>
    ["uno-computer", "metrics", environmentId, boxId] as const,
  activity: (environmentId: EnvironmentId | null, boxId: number | null) =>
    ["uno-computer", "activity", environmentId, boxId] as const,
  apps: (environmentId: EnvironmentId | null, boxId: number | null) =>
    ["uno-computer", "apps", environmentId, boxId] as const,
};

function target(boxId: number | null) {
  return boxId === null ? {} : { boxId };
}

function api(environmentId: EnvironmentId | null) {
  if (environmentId === null) throw new Error("No connection to this computer.");
  return ensureEnvironmentApi(environmentId).unoComputer;
}

export function computerStateQueryOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
) {
  return queryOptions({
    queryKey: computerQueryKeys.state(environmentId, boxId),
    queryFn: () => api(environmentId).getState(target(boxId)),
    enabled: environmentId !== null,
    refetchInterval: STATE_REFETCH_MS,
  });
}

export function computerMetricsQueryOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: computerQueryKeys.metrics(environmentId, boxId),
    queryFn: () => api(environmentId).metrics(target(boxId)),
    enabled: environmentId !== null && enabled,
    refetchInterval: (query) =>
      refetchFor(query.state.data as UnoComputerMetrics | undefined, METRICS_REFETCH_MS),
  });
}

export function computerActivityQueryOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: computerQueryKeys.activity(environmentId, boxId),
    queryFn: () => api(environmentId).activity({ ...target(boxId), tail: 40 }),
    enabled: environmentId !== null && enabled,
    refetchInterval: (query) => refetchFor(query.state.data, ACTIVITY_REFETCH_MS),
  });
}

export function computerAppsQueryOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: computerQueryKeys.apps(environmentId, boxId),
    queryFn: () => api(environmentId).apps(target(boxId)),
    enabled: environmentId !== null && enabled,
    refetchInterval: (query) => {
      const data = query.state.data as UnoComputerApps | undefined;
      return data?.catalog.availability === "unavailable" &&
        data.installed.availability === "unavailable"
        ? UNAVAILABLE_RECHECK_MS
        : APPS_REFETCH_MS;
    },
  });
}

function refetchFor(
  data: { readonly availability: UnoComputerMetrics["availability"] } | undefined,
  liveMs: number,
): number {
  if (data?.availability === "unavailable") return UNAVAILABLE_RECHECK_MS;
  return liveMs;
}

export function computerPowerMutationOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "power", environmentId, boxId] as const,
    mutationFn: (input: Pick<UnoComputerPowerInput, "action">): Promise<UnoComputerState> =>
      api(environmentId).power({ ...target(boxId), action: input.action }),
    onSuccess: (state) => {
      queryClient.setQueryData(computerQueryKeys.state(environmentId, boxId), state);
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.metrics(environmentId, boxId),
      });
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.activity(environmentId, boxId),
      });
    },
  });
}
