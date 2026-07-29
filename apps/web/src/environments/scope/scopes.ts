/**
 * scopes — the settings surface's view of "whose settings am I editing?".
 *
 * Settings are split into two scopes that used to be mixed on one page:
 *
 *   - the **app** scope — this copy of Uno Work on this device (appearance,
 *     UI, update channel, the browser pane, the connections registry). It
 *     belongs to no daemon and follows the user between environments.
 *   - an **environment** scope — one execution environment's own state
 *     (providers, model visibility, CLI paths, assistants, server defaults).
 *     There is one such scope per environment the app knows about.
 *
 * Every environment-scoped page carries its environment in the URL, so a
 * refresh or a back/forward keeps editing the same machine. This module
 * resolves the id to the label and live status those pages display, for both
 * the primary environment and saved remote ones.
 *
 * @module environments/scope/scopes
 */
import type {
  AuthSessionRole,
  EnvironmentConnectionState,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentDescriptor } from "../primary";
import { useSavedEnvironmentRegistryStore, useSavedEnvironmentRuntimeStore } from "../runtime";
import { type EnvironmentAvailability, describeEnvironmentAvailability } from "./availability";

export interface EnvironmentScopeInfo {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Where the daemon runs, from the user's point of view. */
  readonly placement: "local" | "remote";
  readonly connectionState: EnvironmentConnectionState;
  /**
   * Role of the session this device holds on the environment. `null` for the
   * primary daemon, whose cookie session owns it by construction.
   */
  readonly sessionRole: AuthSessionRole | null;
  readonly availability: EnvironmentAvailability;
  /** Last confirmed sync, ISO. `null` for "never". */
  readonly lastSynchronizedAt: string | null;
  readonly lastError: string | null;
}

function describePlatform(descriptor: ExecutionEnvironmentDescriptor | null): string | null {
  if (!descriptor) return null;
  const os =
    descriptor.platform.os === "darwin"
      ? "macOS"
      : descriptor.platform.os === "windows"
        ? "Windows"
        : descriptor.platform.os === "linux"
          ? "Linux"
          : descriptor.platform.os;
  return `${os} ${descriptor.platform.arch}`.trim();
}

export function describeEnvironmentPlatform(
  descriptor: ExecutionEnvironmentDescriptor | null,
): string | null {
  return describePlatform(descriptor);
}

/**
 * Every environment the app can currently address, primary first. Used by the
 * settings scope switcher so the user can move between machines without
 * leaving Settings.
 */
export function useEnvironmentScopes(): ReadonlyArray<EnvironmentScopeInfo> {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(() => {
    const primary: ReadonlyArray<EnvironmentScopeInfo> = primaryDescriptor
      ? [
          {
            environmentId: primaryDescriptor.environmentId,
            label: primaryDescriptor.label,
            placement: "local",
            // The renderer is served by this daemon; if it were gone the app
            // would not be rendering this page at all.
            connectionState: "connected",
            sessionRole: null,
            availability: describeEnvironmentAvailability("connected"),
            lastSynchronizedAt: null,
            lastError: null,
          },
        ]
      : [];

    const saved = Object.values(savedRegistry)
      .filter((record) => record.environmentId !== primaryDescriptor?.environmentId)
      .toSorted((left, right) => left.label.localeCompare(right.label))
      .map((record): EnvironmentScopeInfo => {
        const runtime = savedRuntime[record.environmentId];
        const connectionState = runtime?.connectionState ?? "disconnected";
        const sessionRole = runtime?.role ?? null;
        return {
          environmentId: record.environmentId,
          label: runtime?.descriptor?.label ?? record.label,
          placement: "remote",
          connectionState,
          sessionRole,
          availability: describeEnvironmentAvailability(connectionState, { sessionRole }),
          lastSynchronizedAt: runtime?.lastSynchronizedAt ?? null,
          lastError: runtime?.lastError ?? null,
        };
      });

    return [...primary, ...saved];
  }, [primaryDescriptor, savedRegistry, savedRuntime]);
}

/**
 * The scope for one id, or `null` when the app has no such environment —
 * which is how a stale URL is detected rather than quietly redirected to
 * whatever is active.
 */
export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
): EnvironmentScopeInfo | null {
  const scopes = useEnvironmentScopes();
  return useMemo(
    () =>
      environmentId === null
        ? null
        : (scopes.find((scope) => scope.environmentId === environmentId) ?? null),
    [environmentId, scopes],
  );
}
