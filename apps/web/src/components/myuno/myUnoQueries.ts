/**
 * React Query wiring for "My Uno". Keys live under `["workspace", …]` so that
 * signing in (which invalidates `workspace`) refreshes the whole screen.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  fetchAccountComputers,
  fetchBalance,
  fetchCloudUsage,
  fetchComputerApps,
  fetchComputerLogs,
  fetchComputerMetrics,
  fetchPayments,
  fetchPlanCatalog,
  fetchSites,
  fetchSubscription,
} from "../../account/accountOverview";
import { accountTransport } from "../../account/unoAccount";

const ROOT = ["workspace", "myUno"] as const;

export const myUnoKeys = {
  all: ROOT,
  computers: [...ROOT, "computers"] as const,
  subscription: [...ROOT, "subscription"] as const,
  plans: [...ROOT, "plans"] as const,
  balance: [...ROOT, "balance"] as const,
  sites: [...ROOT, "sites"] as const,
  cloud: [...ROOT, "cloud"] as const,
  payments: [...ROOT, "payments"] as const,
  apps: (id: number) => [...ROOT, "apps", id] as const,
  metrics: (id: number) => [...ROOT, "metrics", id] as const,
  logs: (id: number) => [...ROOT, "logs", id] as const,
};

/** The account is reachable from this interface at all (signed in or not). */
export function accountReachable(): boolean {
  return accountTransport() !== "none";
}

const enabled = () => accountReachable();

// A 401/403 is an answer, not a flake: don't hammer the console with retries.
function retry(failureCount: number, error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  if (/^(401|403|404)\b/.test(message) || /Sign in/.test(message)) return false;
  return failureCount < 2;
}

export const computersQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.computers,
    queryFn: fetchAccountComputers,
    enabled: enabled(),
    refetchInterval: 15_000,
    retry,
  });

export const subscriptionQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.subscription,
    queryFn: fetchSubscription,
    enabled: enabled(),
    staleTime: 30_000,
    retry,
  });

export const plansQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.plans,
    queryFn: fetchPlanCatalog,
    enabled: enabled(),
    staleTime: 5 * 60_000,
    retry,
  });

export const balanceQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.balance,
    queryFn: fetchBalance,
    enabled: enabled(),
    staleTime: 30_000,
    retry,
  });

export const sitesQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.sites,
    queryFn: fetchSites,
    enabled: enabled(),
    staleTime: 60_000,
    retry,
  });

export const cloudQuery = () =>
  queryOptions({
    queryKey: myUnoKeys.cloud,
    queryFn: fetchCloudUsage,
    enabled: enabled(),
    staleTime: 60_000,
    retry,
  });

export const paymentsQuery = (on: boolean) =>
  queryOptions({
    queryKey: myUnoKeys.payments,
    queryFn: fetchPayments,
    enabled: enabled() && on,
    staleTime: 60_000,
    retry,
  });

export const computerAppsQuery = (id: number, on: boolean) =>
  queryOptions({
    queryKey: myUnoKeys.apps(id),
    queryFn: () => fetchComputerApps(id),
    enabled: enabled() && on,
    staleTime: 60_000,
    retry,
  });

export const computerMetricsQuery = (id: number, on: boolean) =>
  queryOptions({
    queryKey: myUnoKeys.metrics(id),
    queryFn: () => fetchComputerMetrics(id),
    enabled: enabled() && on,
    refetchInterval: on ? 10_000 : false,
    retry,
  });

export const computerLogsQuery = (id: number, on: boolean) =>
  queryOptions({
    queryKey: myUnoKeys.logs(id),
    queryFn: () => fetchComputerLogs(id),
    enabled: enabled() && on,
    refetchInterval: on ? 15_000 : false,
    retry,
  });

export function refreshMyUno(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: myUnoKeys.all });
  // The sidebar switcher and Home read the same computers.
  void queryClient.invalidateQueries({ queryKey: ["workspace", "uno-cloud"] });
}
