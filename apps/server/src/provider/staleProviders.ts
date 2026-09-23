import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

/**
 * How old a provider snapshot may be before a newly connected client asks for
 * it to be probed again.
 *
 * Every instance already re-probes itself on a timer (every 5 minutes; 30 for
 * OpenCode and Uno, whose probe is the heavy one), so a connecting client normally
 * finds fresh snapshots. Probing is not free: it starts every harness CLI and,
 * for OpenCode and Uno, a whole `serve` process — several seconds of a full
 * processor on a small cloud computer. Doing that on every page open, reload,
 * extra tab or reconnect made an idle computer read "busy" in its own
 * "This computer" screen. Only a snapshot the timer has clearly missed is
 * refreshed on connect.
 */
export const PROVIDER_CONNECT_REFRESH_MAX_AGE_MS = 35 * 60_000;

/** Instances whose last check is older than `maxAgeMs` (or has no usable time). */
export function staleProviderInstanceIds(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "checkedAt">>,
  nowMs: number,
  maxAgeMs: number = PROVIDER_CONNECT_REFRESH_MAX_AGE_MS,
): ProviderInstanceId[] {
  const stale: ProviderInstanceId[] = [];
  for (const provider of providers) {
    const checkedAtMs = Date.parse(provider.checkedAt);
    if (!Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > maxAgeMs) {
      if (!stale.includes(provider.instanceId)) stale.push(provider.instanceId);
    }
  }
  return stale;
}
