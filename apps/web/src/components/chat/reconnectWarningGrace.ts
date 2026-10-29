import { useEffect, useState } from "react";

/**
 * A reconnect that finishes within this long shows no "is reconnecting"
 * notice: a laptop waking up, a network switch or a server restart usually
 * recovers in well under it, and the notice flashing in and out read as an
 * error. Upstream t3code ed886fe181 + 33aa461478.
 */
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

type ConnectionStateLike = "connecting" | "reconnecting" | "disconnected" | "error";

export function isTransientReconnectState(state: ConnectionStateLike | null): boolean {
  return state === "connecting" || state === "reconnecting";
}

/**
 * Key of one reconnect episode: the environment while it is connecting or
 * reconnecting, otherwise null. A new episode (even to the same environment
 * after it was connected) gets its own grace period.
 */
export function reconnectEpisodeKey(
  unavailable: {
    readonly environmentId: string;
    readonly connectionState: ConnectionStateLike;
  } | null,
): string | null {
  return unavailable && isTransientReconnectState(unavailable.connectionState)
    ? unavailable.environmentId
    : null;
}

/**
 * Whether the "machine is unavailable" notice should show now. Hard states
 * (disconnected, error) show at once so Reconnect stays reachable; transient
 * ones only after the grace period of their episode has passed.
 */
export function useReconnectWarningVisible(
  unavailable: {
    readonly environmentId: string;
    readonly connectionState: ConnectionStateLike;
  } | null,
): boolean {
  const episodeKey = reconnectEpisodeKey(unavailable);
  const [elapsedEpisodeKey, setElapsedEpisodeKey] = useState<string | null>(null);
  // Each reconnect attempt gets its own grace period, including a later one
  // to the same environment.
  const [trackedEpisodeKey, setTrackedEpisodeKey] = useState(episodeKey);
  if (trackedEpisodeKey !== episodeKey) {
    setTrackedEpisodeKey(episodeKey);
    setElapsedEpisodeKey(null);
  }
  useEffect(() => {
    if (episodeKey === null) return;
    const timeoutId = globalThis.setTimeout(
      () => setElapsedEpisodeKey(episodeKey),
      ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
    );
    return () => globalThis.clearTimeout(timeoutId);
  }, [episodeKey]);

  if (unavailable === null) return false;
  if (episodeKey === null) return true;
  return elapsedEpisodeKey === episodeKey;
}
