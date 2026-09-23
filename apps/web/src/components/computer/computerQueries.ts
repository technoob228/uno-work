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
  UnoComputerRemoveAppInput,
  UnoComputerSetAppAiLimitInput,
  UnoComputerState,
  UnoMachineAppActionInput,
  UnoMachineApps,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../../environmentApi";
import { boostRefetchMs } from "./boostModel";

const STATE_REFETCH_MS = 15_000;
const METRICS_REFETCH_MS = 5_000;
const ACTIVITY_REFETCH_MS = 10_000;
const APPS_REFETCH_MS = 30_000;
/** Programs on the machine: a new one should appear within seconds. */
const MACHINE_APPS_REFETCH_MS = 5_000;
const LOCAL_METRICS_REFETCH_MS = 3_000;
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
  machineApps: (environmentId: EnvironmentId | null) =>
    ["uno-computer", "machine-apps", environmentId] as const,
  localMetrics: (environmentId: EnvironmentId | null) =>
    ["uno-computer", "local-metrics", environmentId] as const,
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
    // A boost restarts the computer: read it every few seconds while it switches.
    refetchInterval: (query) =>
      boostRefetchMs(
        (query.state.data as UnoComputerState | undefined)?.box?.boost,
        Date.now(),
        STATE_REFETCH_MS,
      ),
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

/** Programs found on the machine behind this environment (not another picked box). */
export function machineAppsQueryOptions(environmentId: EnvironmentId | null, enabled = true) {
  return queryOptions({
    queryKey: computerQueryKeys.machineApps(environmentId),
    queryFn: () => api(environmentId).machineApps(),
    enabled: environmentId !== null && enabled,
    refetchInterval: MACHINE_APPS_REFETCH_MS,
  });
}

/** Live CPU / memory / disk read by the daemon from its own OS. */
export function localMetricsQueryOptions(environmentId: EnvironmentId | null, enabled = true) {
  return queryOptions({
    queryKey: computerQueryKeys.localMetrics(environmentId),
    queryFn: () => api(environmentId).localMetrics(),
    enabled: environmentId !== null && enabled,
    refetchInterval: LOCAL_METRICS_REFETCH_MS,
  });
}

export function machineAppActionMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "app-action", environmentId] as const,
    mutationFn: (input: UnoMachineAppActionInput): Promise<UnoMachineApps> =>
      api(environmentId).appAction(input),
    onSuccess: (apps) => {
      queryClient.setQueryData(computerQueryKeys.machineApps(environmentId), apps);
    },
  });
}

/**
 * Remove an App Store app. On success the app leaves the list at once (the
 * console no longer returns it), then both lists are read again.
 */
export function removeStoreAppMutationOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "remove-app", environmentId, boxId] as const,
    mutationFn: (input: Omit<UnoComputerRemoveAppInput, "boxId">) =>
      api(environmentId).removeApp({ ...target(boxId), ...input }),
    onSuccess: (_result, input) => {
      queryClient.setQueryData(
        computerQueryKeys.apps(environmentId, boxId),
        (prev: UnoComputerApps | undefined) =>
          prev
            ? {
                ...prev,
                installed: {
                  ...prev.installed,
                  apps: prev.installed.apps.filter((a) => a.deploymentId !== input.deploymentId),
                },
              }
            : prev,
      );
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.apps(environmentId, boxId),
      });
      void queryClient.invalidateQueries({
        queryKey: computerQueryKeys.machineApps(environmentId),
      });
    },
  });
}

/** The spending limit of an App Store app's own AI key. */
export function setAppAiLimitMutationOptions(
  environmentId: EnvironmentId | null,
  boxId: number | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["uno-computer", "app-ai-limit", environmentId, boxId] as const,
    mutationFn: (input: Omit<UnoComputerSetAppAiLimitInput, "boxId">) =>
      api(environmentId).setAppAiLimit({ ...target(boxId), ...input }),
    onSuccess: (result, input) => {
      queryClient.setQueryData(
        computerQueryKeys.apps(environmentId, boxId),
        (prev: UnoComputerApps | undefined) =>
          prev
            ? {
                ...prev,
                installed: {
                  ...prev.installed,
                  apps: prev.installed.apps.map((a) =>
                    a.deploymentId === input.deploymentId ? { ...a, aiKey: result.aiKey } : a,
                  ),
                },
              }
            : prev,
      );
    },
  });
}

/**
 * Sign in with Uno on the app card: a one-time link that opens the app already
 * signed in, and who the app is shared with. Plain calls rather than queries:
 * the link must be asked for at the moment of the click (it works once, for a
 * minute), and the share list lives only while its card is open.
 */
export function appSignInApi(environmentId: EnvironmentId | null, boxId: number | null) {
  return {
    openLink: (deploymentId: number) =>
      api(environmentId).openApp({ ...target(boxId), deploymentId }),
    access: (deploymentId: number) =>
      api(environmentId).appAccess({ ...target(boxId), deploymentId }),
    share: (deploymentId: number, login: string) =>
      api(environmentId).shareApp({ ...target(boxId), deploymentId, login }),
    unshare: (deploymentId: number, userId: number) =>
      api(environmentId).unshareApp({ ...target(boxId), deploymentId, userId }),
  };
}
