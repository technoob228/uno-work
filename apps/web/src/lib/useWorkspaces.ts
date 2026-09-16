/**
 * The workspaces this client can see.
 *
 * A daemon belongs to exactly one workspace and serves its registry, so the
 * set of workspaces is "what the connected daemons say they belong to",
 * deduplicated by `workspaceId`. Two daemons in the same workspace answer with
 * the same id and collapse into one row — which is the whole point of the
 * switcher: you pick a *workspace*, not a box.
 *
 * Machines come from the registry rather than from the client's connection
 * list, because a workspace legitimately contains machines this client has
 * never connected to (an adopted box that is asleep). Those are shown, and
 * shown as unreachable, rather than hidden — a switcher that silently omits
 * half the workspace is worse than one that admits it cannot reach it.
 */
import type { EnvironmentId, WorkspaceMachine, WorkspaceState } from "@t3tools/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { deriveMachineKind, registryKindForMachineKind } from "../machineKind";
import {
  workspaceStateQueryOptions,
  workspaceSyncMachinesMutationOptions,
} from "./workspaceReactQuery";

export interface WorkspaceMachineEntry {
  readonly machine: WorkspaceMachine;
  /** True when this client currently holds a connection to it. */
  readonly connected: boolean;
}

export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly name: string;
  readonly epoch: number;
  /** The daemon whose registry answered — where mutations are sent. */
  readonly registryEnvironmentId: EnvironmentId;
  readonly machines: readonly WorkspaceMachineEntry[];
  /** Machines in the registry this client cannot currently reach. */
  readonly unreachableCount: number;
  readonly state: WorkspaceState;
}

export interface WorkspaceDirectory {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly isLoading: boolean;
  /** Environments connected but whose registry could not be read. */
  readonly unreadableEnvironmentIds: readonly EnvironmentId[];
}

/**
 * Make sure the daemon we are talking to is listed in its own registry.
 *
 * The registry only fills in when someone presses "Sync connections" in the
 * Workspace settings, so a fresh box answers "whole workspace · 0 machines"
 * to the inbox switcher — which reads as broken, not as empty. The daemon
 * itself is the one machine we know for certain is in the workspace, so it
 * is registered on sight; other machines still go through the explicit sync.
 */
export function useEnsureOwnMachineRegistered(): void {
  const queryClient = useQueryClient();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = primaryDescriptor?.environmentId ?? null;
  const savedLabel = useSavedEnvironmentRegistryStore((state) =>
    primaryEnvironmentId ? state.byId[primaryEnvironmentId]?.label : undefined,
  );
  const stateQuery = useQuery(workspaceStateQueryOptions(primaryEnvironmentId));
  const syncMachines = useMutation(
    workspaceSyncMachinesMutationOptions(primaryEnvironmentId, queryClient),
  );
  // One attempt per workspace: a registry that refuses the write must not be
  // hammered on every render.
  const attemptedForWorkspaceId = useRef<string | null>(null);

  const state = stateQuery.data;
  const mutate = syncMachines.mutate;
  useEffect(() => {
    if (!primaryEnvironmentId || !state) return;
    if (attemptedForWorkspaceId.current === state.identity.workspaceId) return;
    if (state.machines.some((machine) => machine.environmentId === primaryEnvironmentId)) return;
    attemptedForWorkspaceId.current = state.identity.workspaceId;
    // Register under what the daemon says it is: a box registers as a box,
    // not as "local" just because it is the one doing the registering.
    const kind = registryKindForMachineKind(deriveMachineKind({ descriptor: primaryDescriptor }));
    mutate({
      machines: [
        {
          environmentId: primaryEnvironmentId,
          label: savedLabel?.trim() || primaryDescriptor?.label || "This machine",
          kind,
          ...(kind === "uno_box" && primaryDescriptor?.unoBoxId != null
            ? { unoBoxId: primaryDescriptor.unoBoxId }
            : {}),
          lastSeenAt: new Date().toISOString(),
        },
      ],
      registryEnvironmentId: primaryEnvironmentId,
    });
  }, [mutate, primaryDescriptor, primaryEnvironmentId, savedLabel, state]);
}

export function useWorkspaces(): WorkspaceDirectory {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  const connectedEnvironmentIds = useMemo<readonly EnvironmentId[]>(() => {
    const connected = Object.values(savedRegistry)
      .filter((record) => runtimeById[record.environmentId]?.connectionState === "connected")
      .map((record) => record.environmentId);
    return primaryEnvironmentId
      ? [primaryEnvironmentId, ...connected.filter((id) => id !== primaryEnvironmentId)]
      : connected;
  }, [primaryEnvironmentId, runtimeById, savedRegistry]);

  const results = useQueries({
    queries: connectedEnvironmentIds.map((environmentId) =>
      workspaceStateQueryOptions(environmentId),
    ),
  });

  return useMemo<WorkspaceDirectory>(() => {
    const byWorkspaceId = new Map<string, WorkspaceSummary>();
    const unreadable: EnvironmentId[] = [];
    let isLoading = false;

    results.forEach((result, index) => {
      const environmentId = connectedEnvironmentIds[index];
      if (!environmentId) return;
      if (result.isPending) {
        isLoading = true;
        return;
      }
      const state = result.data;
      if (!state) {
        unreadable.push(environmentId);
        return;
      }

      const existing = byWorkspaceId.get(state.identity.workspaceId);
      // Ties go to the daemon the registry itself names, then to the higher
      // epoch: a second daemon answering about the same workspace may simply
      // be behind.
      const preferIncoming =
        !existing ||
        state.identity.registryEnvironmentId === environmentId ||
        state.identity.epoch > existing.epoch;
      if (!preferIncoming) return;

      const machines = state.machines.map((machine) => ({
        machine,
        connected:
          machine.environmentId === environmentId ||
          connectedEnvironmentIds.includes(machine.environmentId),
      }));

      byWorkspaceId.set(state.identity.workspaceId, {
        workspaceId: state.identity.workspaceId,
        name: state.identity.name,
        epoch: state.identity.epoch,
        registryEnvironmentId: environmentId,
        machines,
        unreachableCount: machines.filter((entry) => !entry.connected).length,
        state,
      });
    });

    return {
      workspaces: [...byWorkspaceId.values()].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
      isLoading,
      unreadableEnvironmentIds: unreadable,
    };
  }, [connectedEnvironmentIds, results]);
}
