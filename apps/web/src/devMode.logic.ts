/**
 * Dev mode across devices and computers, without a backend.
 *
 * The switch lives in each computer's server settings (`devMode`,
 * `devModeChangedAt`), this device keeps a copy so the first paint and route
 * guards don't wait for a connection. Whenever the two differ the newest
 * change wins and the older side catches up: a new device adopts it from the
 * computer, a computer that was asleep gets it from the device.
 */
export interface DevModeState {
  readonly enabled: boolean;
  /** ISO time of the last change; null when nobody ever chose. */
  readonly changedAt: string | null;
}

export type DevModeReconciliation =
  | { readonly kind: "in-sync" }
  /** The computer's choice is newer: this device takes it. */
  | { readonly kind: "adopt"; readonly state: DevModeState }
  /** This device's choice is newer: the computer takes it. */
  | { readonly kind: "push"; readonly state: DevModeState };

const changedAtMs = (state: DevModeState): number => {
  const parsed = state.changedAt === null ? Number.NaN : Date.parse(state.changedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

export function reconcileDevMode(input: {
  readonly local: DevModeState;
  readonly computer: DevModeState;
  /** Stamps a device flag from before the switch had a time (localStorage "1"). */
  readonly now: string;
}): DevModeReconciliation {
  const { local, computer, now } = input;
  const localAt = changedAtMs(local);
  const computerAt = changedAtMs(computer);
  if (localAt === computerAt) {
    if (localAt === Number.NEGATIVE_INFINITY && local.enabled && !computer.enabled) {
      return { kind: "push", state: { enabled: true, changedAt: now } };
    }
    return { kind: "in-sync" };
  }
  if (computerAt > localAt) return { kind: "adopt", state: computer };
  return { kind: "push", state: local };
}
