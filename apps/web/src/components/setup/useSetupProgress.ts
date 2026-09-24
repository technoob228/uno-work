/**
 * Setup progress on the machine (`settings.setup`). Reads come from the
 * unified settings; writes replace the whole record, computed from the
 * freshest copy (the optimistic one after the previous write), so quick
 * clicks through the steps never lose each other's updates.
 */
import type { UnoSetupProgress } from "@t3tools/contracts";
import { useCallback } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { getServerConfig } from "../../rpc/serverState";
import { EMPTY_SETUP_PROGRESS } from "./setupModel";

const selectSetup = (settings: { readonly setup?: UnoSetupProgress }) =>
  settings.setup ?? EMPTY_SETUP_PROGRESS;

export function useSetupProgress(): UnoSetupProgress {
  return useSettings(selectSetup);
}

export function currentSetupProgress(): UnoSetupProgress {
  return getServerConfig()?.settings.setup ?? EMPTY_SETUP_PROGRESS;
}

export function useUpdateSetupProgress(): (
  change: (current: UnoSetupProgress) => UnoSetupProgress,
) => Promise<void> {
  const { updateSettings } = useUpdateSettings();
  return useCallback(
    (change) => {
      const current = currentSetupProgress();
      const next = change(current);
      if (next === current) return Promise.resolve();
      return updateSettings({ setup: next });
    },
    [updateSettings],
  );
}
