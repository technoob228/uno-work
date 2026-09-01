/**
 * React access to the Labs / feature-flag state.
 *
 * Reads from the unified settings (the `featureFlags` map lives in the
 * localStorage-backed client settings) and resolves each key against the
 * registry defaults in `../featureFlags`.
 */
import { useCallback } from "react";

import { type FeatureFlagKey, resolveFeatureFlag } from "../featureFlags";
import { useSettings, useUpdateSettings } from "./useSettings";

/** Read a single flag's effective value (stored override, else default). */
export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useSettings((settings) => resolveFeatureFlag(settings.featureFlags, key));
}

/** The whole sparse override map, for panels that render every flag. */
export function useFeatureFlagOverrides(): Readonly<Record<string, boolean>> {
  return useSettings((settings) => settings.featureFlags);
}

/**
 * Returns a setter that persists one flag's on/off choice to client settings.
 * The `featureFlags` map is stored whole, so we merge the new value into the
 * current overrides rather than replacing the map.
 */
export function useSetFeatureFlag(): (key: FeatureFlagKey, value: boolean) => void {
  const { updateSettings } = useUpdateSettings();
  const overrides = useFeatureFlagOverrides();
  return useCallback(
    (key: FeatureFlagKey, value: boolean) => {
      void updateSettings({ featureFlags: { ...overrides, [key]: value } });
    },
    [overrides, updateSettings],
  );
}
