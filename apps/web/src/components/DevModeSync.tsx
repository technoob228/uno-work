import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { readDevModeState, useDevMode, writeDevModeState } from "../devMode";
import { reconcileDevMode } from "../devMode.logic";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { updateEnvironmentSettings } from "../environments/settings/serverSettings";
import { useServerConfig } from "../rpc/serverState";

/**
 * Keeps Dev mode the same on this device and every computer it can reach.
 * Renders nothing. Runs on any change of the switch or of a computer's
 * settings, and a computer that couldn't take a change gets one more try only
 * when something changes again: a view-only session stays quiet.
 */
export function DevModeSync() {
  const devMode = useDevMode();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryConfig = useServerConfig();
  const savedEnvironments = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    const computers: Array<[EnvironmentId, ServerConfig]> = [];
    if (primaryEnvironmentId && primaryConfig)
      computers.push([primaryEnvironmentId, primaryConfig]);
    for (const [id, runtime] of Object.entries(savedEnvironments)) {
      if (id !== primaryEnvironmentId && runtime.serverConfig) {
        computers.push([id as EnvironmentId, runtime.serverConfig]);
      }
    }
    for (const [environmentId, config] of computers) {
      const decision = reconcileDevMode({
        local: readDevModeState(),
        computer: {
          enabled: config.settings.devMode,
          changedAt: config.settings.devModeChangedAt,
        },
        now: new Date().toISOString(),
      });
      if (decision.kind === "adopt") {
        writeDevModeState(decision.state);
      } else if (decision.kind === "push") {
        const key = `${environmentId}:${decision.state.enabled}:${decision.state.changedAt}`;
        if (tried.current.has(key)) continue;
        tried.current.add(key);
        // A stamp made here (a flag from before the sync) stays on this device too.
        if (readDevModeState().changedAt !== decision.state.changedAt) {
          writeDevModeState(decision.state);
        }
        void updateEnvironmentSettings(environmentId, {
          devMode: decision.state.enabled,
          devModeChangedAt: decision.state.changedAt,
        }).catch((error: unknown) => {
          console.warn("[dev-mode] a computer did not take the change", environmentId, error);
        });
      }
    }
  }, [devMode, primaryConfig, primaryEnvironmentId, savedEnvironments]);

  return null;
}
