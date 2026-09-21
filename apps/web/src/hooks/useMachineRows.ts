/**
 * The machine list, folded once for the whole app.
 *
 * `buildMachineRows` needs five sources (the primary descriptor, saved
 * connections and their live state, the workspace registry, the boxes on the
 * Uno account). Every surface that lists machines — the sidebar switcher,
 * Settings "Applies to", My machines, the default-machine rule — reads them
 * through this hook so a machine's kind and status are the same everywhere.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { usePrimaryEnvironmentDescriptor } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { unoCloudStateQueryOptions, workspaceStateQueryOptions } from "~/lib/workspaceReactQuery";
import type { MachineKindDescriptorHint } from "~/machineKind";

import { buildMachineRows, type MachineRow } from "../components/settings/machineRows";
import { useSettings } from "./useSettings";

const NO_PROJECTS: ReadonlyMap<string, ReadonlyArray<string>> = new Map();

export interface UseMachineRowsOptions {
  readonly projectNamesByEnvironmentId?: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
  /** Clock for "seen 5m ago" details; callers that tick pass their own. */
  readonly now?: number | undefined;
}

/**
 * environmentId → the name to show for that machine (Uno box name when the
 * machine is a box, otherwise its saved or daemon label). Surfaces that name a
 * machine without listing them all — the switcher, the empty chat state, the
 * sidebar chips — read this so a box is called the same everywhere.
 */
export function useMachineLabels(): ReadonlyMap<string, string> {
  const rows = useMachineRows();
  return useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of rows) {
      if (row.environmentId) labels.set(row.environmentId, row.label);
    }
    return labels;
  }, [rows]);
}

export function useMachineRows(options?: UseMachineRowsOptions): ReadonlyArray<MachineRow> {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = primaryDescriptor?.environmentId ?? null;
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const defaultEnvironmentId = useSettings((settings) => settings.defaultEnvironmentId);
  const registry = useQuery(workspaceStateQueryOptions(primaryEnvironmentId)).data;
  const cloud = useQuery(unoCloudStateQueryOptions(primaryEnvironmentId)).data;
  const projectNamesByEnvironmentId = options?.projectNamesByEnvironmentId ?? NO_PROJECTS;
  const now = options?.now;

  return useMemo(() => {
    if (!primaryEnvironmentId) return [];
    const descriptorById: Record<string, MachineKindDescriptorHint | null> = {
      [primaryEnvironmentId]: primaryDescriptor,
    };
    const connectionStateById: Record<
      string,
      (typeof runtimeById)[EnvironmentId]["connectionState"]
    > = {};
    for (const [environmentId, runtime] of Object.entries(runtimeById)) {
      connectionStateById[environmentId] = runtime.connectionState;
      descriptorById[environmentId] =
        runtime.descriptor ?? runtime.serverConfig?.environment ?? null;
    }
    return buildMachineRows({
      primaryEnvironmentId,
      primaryLabel: primaryDescriptor?.label,
      descriptorById,
      defaultEnvironmentId,
      registryMachines: registry?.machines ?? [],
      savedEnvironments: Object.values(savedEnvironments).map((record) => ({
        environmentId: record.environmentId,
        label: record.label,
        lastConnectedAt: record.lastConnectedAt,
        unoBoxId: record.unoBoxId,
      })),
      connectionStateById,
      boxes: cloud?.connected ? cloud.boxes : [],
      projectNamesByEnvironmentId,
      now: now ?? Date.now(),
    });
  }, [
    cloud,
    defaultEnvironmentId,
    now,
    primaryDescriptor,
    primaryEnvironmentId,
    projectNamesByEnvironmentId,
    registry,
    runtimeById,
    savedEnvironments,
  ]);
}
