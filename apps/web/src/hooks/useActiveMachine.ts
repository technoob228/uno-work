/**
 * The computer the app is looking at right now, and what kind it is.
 *
 * "Cloud" (an Uno computer) gets the whole computer: home screen, App Store,
 * resize, sleep. A local computer (this Mac in the desktop app, or a laptop
 * running the daemon) is about chats, its files and a terminal — the cloud
 * surfaces are hidden there.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { deriveMachineKind, type MachineKind } from "../machineKind";
import { useStore } from "../store";
import { useMachineRows } from "./useMachineRows";

export interface ActiveMachine {
  readonly environmentId: EnvironmentId | null;
  readonly kind: MachineKind;
  /** An Uno cloud computer. */
  readonly isCloud: boolean;
  /** The daemon serving this page (this Mac in the desktop app). */
  readonly isPrimary: boolean;
}

export function useActiveMachine(): ActiveMachine {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = primaryDescriptor?.environmentId ?? null;
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const rows = useMachineRows();
  const runtimeDescriptor = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? (state.byId[environmentId]?.descriptor ?? null) : null,
  );

  return useMemo(() => {
    const row = environmentId ? rows.find((r) => r.environmentId === environmentId) : undefined;
    const isPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
    const kind: MachineKind =
      row?.kind ??
      deriveMachineKind({
        descriptor: isPrimary ? primaryDescriptor : runtimeDescriptor,
      });
    return { environmentId, kind, isCloud: kind === "uno_box", isPrimary };
  }, [environmentId, primaryDescriptor, primaryEnvironmentId, rows, runtimeDescriptor]);
}
