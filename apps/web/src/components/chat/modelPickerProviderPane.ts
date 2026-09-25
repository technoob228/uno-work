/**
 * Pure view-state for the model picker's per-provider pane.
 *
 * A provider rail item can show one of four things in the content pane:
 * its model list, an install panel, a sign-in panel, or nothing (blocked).
 * The mapping is a function of the provider snapshot alone, so it lives
 * here (unit-tested) rather than inline in the picker. It builds on the
 * shared harness status derivation used by onboarding and settings so the
 * picker never disagrees with those surfaces about what a provider needs.
 *
 * @module components/chat/modelPickerProviderPane
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  isJobActive,
  resolveHarnessAction,
  resolveHarnessStatus,
  type SetupJobView,
} from "../harness/harnessSetupState";

export type ProviderPaneKind =
  /** Installed and signed in: show the model list. */
  | "models"
  /** Binary missing and the daemon knows how to install it. */
  | "install"
  /** Installed but the CLI has no usable account, and we can sign it in. */
  | "signin"
  /** Disabled in settings, unavailable, or broken in a way we cannot fix here. */
  | "blocked";

export function resolveProviderPaneKind(
  entry: Pick<
    ProviderInstanceEntry,
    "enabled" | "isAvailable" | "installed" | "status" | "driverKind" | "snapshot"
  >,
): ProviderPaneKind {
  if (!entry.enabled || !entry.isAvailable) return "blocked";
  const status = resolveHarnessStatus({ provider: entry.snapshot, providersLoaded: true });
  const action = resolveHarnessAction({ driver: entry.driverKind, status });
  if (action === "install") return "install";
  if (action === "signIn") return "signin";
  // Signed out of a harness without the in-app dialog (an OpenCode key, the
  // Uno key, Cursor's terminal login): still a sign-in pane, which points to
  // the fix instead of greying the harness out.
  if (
    status === "needsSignIn" &&
    entry.snapshot.auth.status === "unauthenticated" &&
    SIGN_IN_ELSEWHERE_DRIVERS.has(entry.driverKind)
  ) {
    return "signin";
  }
  return entry.status === "ready" ? "models" : "blocked";
}

/** Harnesses whose sign-in lives outside the in-app dialog (see ProviderSetupPane). */
export const SIGN_IN_ELSEWHERE_DRIVERS: ReadonlySet<string> = new Set([
  "opencode",
  "cursor",
  "uno",
  "hermes",
]);

export type ProviderPaneBadge = "Not installed" | "Sign in needed" | "Installing…" | "Ready";

/**
 * Short state label for the rail tooltip / accessible name. `null` for
 * blocked providers, whose tooltip already explains why they are greyed out.
 */
export function providerPaneBadgeLabel(input: {
  readonly kind: ProviderPaneKind;
  readonly installJob?: SetupJobView | undefined;
}): ProviderPaneBadge | null {
  if (input.kind === "install") {
    return isJobActive(input.installJob) ? "Installing…" : "Not installed";
  }
  if (input.kind === "signin") return "Sign in needed";
  if (input.kind === "models") return "Ready";
  return null;
}

/**
 * Combobox keys for the "set up this agent" rows that appear in search
 * results. Model keys are `${instanceId}:${slug}`; a control character
 * prefix keeps setup keys out of that namespace without a second lookup.
 */
const PROVIDER_SETUP_KEY_PREFIX = "setup:";

export function providerSetupKey(instanceId: ProviderInstanceId): string {
  return `${PROVIDER_SETUP_KEY_PREFIX}${instanceId}`;
}

export function parseProviderSetupKey(key: string): ProviderInstanceId | null {
  if (!key.startsWith(PROVIDER_SETUP_KEY_PREFIX)) return null;
  const instanceId = key.slice(PROVIDER_SETUP_KEY_PREFIX.length);
  return instanceId.length > 0 ? (instanceId as ProviderInstanceId) : null;
}
