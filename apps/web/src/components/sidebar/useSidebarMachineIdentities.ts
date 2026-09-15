/**
 * Machine identity chips for the sidebar: which monogram and hue each machine
 * (environment) gets, with newly assigned slots persisted to settings so a chip
 * never changes colour when another machine is attached. Same rules as the
 * legacy sidebar, lifted into a hook for the chat-list sidebar.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { resolveMachineIdentities } from "../../machineIdentity";

export function useSidebarEnvironmentLabelResolver(): (
  environmentId: EnvironmentId,
) => string | null {
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  return useCallback(
    (environmentId: EnvironmentId): string | null => {
      const runtime = savedEnvironmentRuntimeById[environmentId];
      const saved = savedEnvironmentRegistry[environmentId];
      return runtime?.descriptor?.label ?? saved?.label ?? null;
    },
    [savedEnvironmentRegistry, savedEnvironmentRuntimeById],
  );
}

export function useSidebarMachineIdentities(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projectEnvironmentIds: readonly EnvironmentId[];
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}) {
  const { primaryEnvironmentId, projectEnvironmentIds, resolveEnvironmentLabel } = input;
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const sidebarMachineIdentitySettings = useSettings((s) => s.sidebarMachineIdentity);
  const sidebarMachineOrderSetting = useSettings((s) => s.sidebarMachineOrder);
  const { updateSettings } = useUpdateSettings();

  // Every machine the sidebar could show a chip for, reachable or not: offline
  // machines keep their rows (dimmed), so their chips have to keep working.
  const machineEnvironmentIds = useMemo<EnvironmentId[]>(() => {
    const ids = new Set<EnvironmentId>();
    if (primaryEnvironmentId !== null) ids.add(primaryEnvironmentId);
    for (const environmentId of Object.keys(savedEnvironmentRegistry) as EnvironmentId[]) {
      ids.add(environmentId);
    }
    for (const environmentId of projectEnvironmentIds) ids.add(environmentId);
    return [...ids];
  }, [primaryEnvironmentId, projectEnvironmentIds, savedEnvironmentRegistry]);

  const resolution = useMemo(
    () =>
      resolveMachineIdentities({
        machines: machineEnvironmentIds.map((environmentId) => ({
          environmentId,
          label: resolveEnvironmentLabel(environmentId),
        })),
        persisted: sidebarMachineIdentitySettings,
        order: sidebarMachineOrderSetting,
      }),
    [
      machineEnvironmentIds,
      resolveEnvironmentLabel,
      sidebarMachineIdentitySettings,
      sidebarMachineOrderSetting,
    ],
  );

  const persistSignatureRef = useRef<string>("");
  useEffect(() => {
    const { slotsToPin, order } = resolution;
    const orderChanged =
      order.length !== sidebarMachineOrderSetting.length ||
      order.some((environmentId, index) => sidebarMachineOrderSetting[index] !== environmentId);
    if (slotsToPin.size === 0 && !orderChanged) return;
    // Guard against re-firing before the settings round trip lands.
    const signature = JSON.stringify([[...slotsToPin.entries()], order]);
    if (persistSignatureRef.current === signature) return;
    persistSignatureRef.current = signature;
    const nextIdentity: Record<string, { monogram: string; colorSlot: number }> = {
      ...sidebarMachineIdentitySettings,
    };
    for (const [environmentId, colorSlot] of slotsToPin) {
      nextIdentity[environmentId] = {
        monogram: sidebarMachineIdentitySettings[environmentId]?.monogram ?? "",
        colorSlot,
      };
    }
    updateSettings({
      ...(slotsToPin.size > 0 ? { sidebarMachineIdentity: nextIdentity } : {}),
      ...(orderChanged ? { sidebarMachineOrder: order } : {}),
    });
  }, [resolution, sidebarMachineIdentitySettings, sidebarMachineOrderSetting, updateSettings]);

  return resolution.identities;
}
