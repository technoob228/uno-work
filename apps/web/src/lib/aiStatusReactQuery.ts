/**
 * Uno AI hours right now, read by the daemon from `GET /v1/ai/status` with
 * the machine's key (apps/server appSdk/aiStatus.ts). The daemon caches and
 * backs off on its own; a gateway without AI hours reads as "unavailable" and
 * every caller then shows nothing.
 */
import type { EnvironmentId, UnoAiStatus } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../environmentApi";

/** While a chat works, the busy notice asks this often. */
export const AI_STATUS_POLL_MS = 15_000;

/** While a premium model is picked, the premium credit is re-read this often. */
export const AI_STATUS_PREMIUM_POLL_MS = 60_000;

export interface AiStatusQueryFlags {
  /** Poll every {@link AI_STATUS_POLL_MS} (a chat on Uno AI is working). */
  readonly poll?: boolean;
  /** Poll at this interval instead (0/undefined: see `poll`). */
  readonly pollMs?: number;
  readonly enabled?: boolean;
}

export function aiStatusQueryOptions(
  environmentId: EnvironmentId | null,
  options: AiStatusQueryFlags = {},
) {
  const pollMs = options.poll ? AI_STATUS_POLL_MS : (options.pollMs ?? 0);
  return queryOptions({
    queryKey: ["uno-ai", "status", environmentId] as const,
    queryFn: (): Promise<UnoAiStatus> =>
      ensureEnvironmentApi(environmentId!).unoComputer.appAiStatus(),
    enabled: environmentId !== null && options.enabled !== false,
    refetchInterval: pollMs > 0 ? pollMs : false,
    staleTime: pollMs > 0 ? pollMs : 60_000,
    retry: false,
  });
}

/** The reading when the gateway has AI hours; null otherwise (or not read yet). */
export function useAiStatus(
  environmentId: EnvironmentId | null,
  options: AiStatusQueryFlags = {},
): UnoAiStatus | null {
  const data = useQuery(aiStatusQueryOptions(environmentId, options)).data;
  return data?.status === "ok" ? data : null;
}

export type AiBusyNotice =
  | { readonly kind: "throttled" }
  | { readonly kind: "standard-speed"; readonly renewsAt: string | null }
  /** A Fast-unlimited plan past its Smart hours: Fast keeps going at standard speed. */
  | { readonly kind: "fast-standard" };

/**
 * What the composer says, or null (the usual case: full speed says nothing).
 * Unlimited plans past the month's full-speed hours run at standard speed
 * until renewal — a different, calmer line.
 */
export function aiBusyNotice(status: UnoAiStatus | null): AiBusyNotice | null {
  if (!status) return null;
  if (status.fastStandardSpeed === true) return { kind: "fast-standard" };
  if (!status.throttled) return null;
  if (status.unlimited && status.fullSpeedHoursLeft !== null && status.fullSpeedHoursLeft <= 0) {
    return { kind: "standard-speed", renewsAt: status.renewsAt };
  }
  return { kind: "throttled" };
}
