/**
 * availability — what the UI is allowed to do with an environment right now.
 *
 * A settings page bound to an environment has three honest states, and they
 * differ in what the user may *do*, not just in what colour the dot is:
 *
 *   - `connected` — reads are current and writes go through;
 *   - `reconnecting` — whatever is on screen came from the last successful
 *     sync, so it is shown read-only and labelled as cached rather than
 *     silently pretending to be live;
 *   - `offline` — nothing is current and writes must be refused, because a
 *     write that cannot reach its daemon is exactly the failure this whole
 *     area exists to prevent.
 *
 * Kept pure and transport-free so both the header chip and the mutation
 * guards derive from one rule instead of each re-deciding.
 *
 * @module environments/scope/availability
 */
import type { EnvironmentConnectionState } from "@t3tools/contracts";

export type EnvironmentAvailabilityStatus = "connected" | "reconnecting" | "offline";

export interface EnvironmentAvailability {
  readonly status: EnvironmentAvailabilityStatus;
  /** Writes are only ever allowed against a confirmed live connection. */
  readonly canMutate: boolean;
  /** Displayed data is from the last sync, not from now. */
  readonly showsCachedData: boolean;
  /** Offering a manual reconnect makes sense in this state. */
  readonly canReconnect: boolean;
}

export function describeEnvironmentAvailability(
  connectionState: EnvironmentConnectionState,
): EnvironmentAvailability {
  switch (connectionState) {
    case "connected":
      return {
        status: "connected",
        canMutate: true,
        showsCachedData: false,
        canReconnect: false,
      };
    case "connecting":
    case "reconnecting":
      return {
        status: "reconnecting",
        canMutate: false,
        showsCachedData: true,
        canReconnect: false,
      };
    case "disconnected":
    case "error":
      return {
        status: "offline",
        canMutate: false,
        showsCachedData: true,
        canReconnect: true,
      };
  }
}

const STATUS_LABEL: Record<EnvironmentAvailabilityStatus, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function environmentAvailabilityLabel(status: EnvironmentAvailabilityStatus): string {
  return STATUS_LABEL[status];
}

/**
 * The "as of" line under the status chip. `elapsedLabel` is the already
 * humanized age of {@link lastSynchronizedAt} (e.g. "4m"), passed in so this
 * module stays clock-free.
 */
export function environmentSyncSummary(input: {
  readonly status: EnvironmentAvailabilityStatus;
  readonly elapsedLabel: string | null;
}): string {
  if (input.elapsedLabel === null) {
    return input.status === "connected" ? "Syncing…" : "Never synced";
  }
  return input.status === "connected"
    ? `Synced ${input.elapsedLabel} ago`
    : `Cached from ${input.elapsedLabel} ago`;
}
