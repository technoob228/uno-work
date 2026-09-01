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
 * The session's role cuts across all three: a daemon can be reachable and in
 * sync while the session we hold on it is client-only, which every manager and
 * orchestration route refuses. That is a live connection the user still cannot
 * write through, so it is surfaced here rather than discovered as a 403 after
 * the save button.
 *
 * Kept pure and transport-free so both the header chip and the mutation
 * guards derive from one rule instead of each re-deciding.
 *
 * @module environments/scope/availability
 */
import type { AuthSessionRole, EnvironmentConnectionState } from "@t3tools/contracts";

export type EnvironmentAvailabilityStatus = "connected" | "reconnecting" | "offline";

/** Why writes are refused, when they are. */
export type EnvironmentMutationBlock = "not-connected" | "client-session";

export interface EnvironmentAvailability {
  readonly status: EnvironmentAvailabilityStatus;
  /** Writes are only ever allowed against a confirmed live connection. */
  readonly canMutate: boolean;
  /** Displayed data is from the last sync, not from now. */
  readonly showsCachedData: boolean;
  /** Offering a manual reconnect makes sense in this state. */
  readonly canReconnect: boolean;
  readonly mutationBlock: EnvironmentMutationBlock | null;
}

export function describeEnvironmentAvailability(
  connectionState: EnvironmentConnectionState,
  options?: { readonly sessionRole?: AuthSessionRole | null },
): EnvironmentAvailability {
  const base = describeConnectionAvailability(connectionState);
  if (!base.canMutate) return base;

  // `undefined` means the caller does not track roles (the primary daemon,
  // whose cookie session is the owner by construction); only an explicitly
  // non-owner role downgrades a live connection.
  const sessionRole = options?.sessionRole;
  if (sessionRole === undefined || sessionRole === "owner") return base;

  return { ...base, canMutate: false, canReconnect: true, mutationBlock: "client-session" };
}

function describeConnectionAvailability(
  connectionState: EnvironmentConnectionState,
): EnvironmentAvailability {
  switch (connectionState) {
    case "connected":
      return {
        status: "connected",
        canMutate: true,
        showsCachedData: false,
        canReconnect: false,
        mutationBlock: null,
      };
    case "connecting":
    case "reconnecting":
      return {
        status: "reconnecting",
        canMutate: false,
        showsCachedData: true,
        canReconnect: false,
        mutationBlock: "not-connected",
      };
    case "disconnected":
    case "error":
      return {
        status: "offline",
        canMutate: false,
        showsCachedData: true,
        canReconnect: true,
        mutationBlock: "not-connected",
      };
  }
}

const MUTATION_BLOCK_MESSAGE: Record<EnvironmentMutationBlock, string> = {
  "not-connected": "Reconnect this environment to change its settings.",
  "client-session":
    "This device holds a view-only session on this environment. Reconnect it to manage its settings.",
};

/** What to tell the user instead of letting them press a doomed save button. */
export function environmentMutationBlockMessage(block: EnvironmentMutationBlock): string {
  return MUTATION_BLOCK_MESSAGE[block];
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
