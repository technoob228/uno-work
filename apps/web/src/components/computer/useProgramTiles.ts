/**
 * The computer's apps as tiles, for surfaces other than the home screen: the
 * sidebar's Apps list and the in-Uno app view (which only frames addresses
 * that belong to this computer). Same sources and rules as the desktop
 * (`buildProgramTiles`); installs in progress stay a home-screen concern.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { computerPowerState } from "./computerFormat";
import {
  appAiQueryOptions,
  computerAppsQueryOptions,
  computerStateQueryOptions,
  machineAppsQueryOptions,
} from "./computerQueries";
import {
  buildProgramTiles,
  isBrowserOnMachine,
  type ProgramTile,
  withAiNotes,
} from "./programModel";

export interface ProgramTilesState {
  readonly tiles: ReadonlyArray<ProgramTile>;
  readonly loading: boolean;
  /** An Uno cloud computer with an account: the App Store is there. */
  readonly hasStore: boolean;
}

export function useProgramTiles(): ProgramTilesState {
  const machine = useActiveMachine();
  const environmentId = machine.environmentId;
  const stateQuery = useQuery(computerStateQueryOptions(environmentId, null));
  const box = stateQuery.data?.box ?? null;
  const hasBox = box !== null;
  const computerOn = box ? computerPowerState(box.status) === "on" : true;
  const machineAppsQuery = useQuery(machineAppsQueryOptions(environmentId, true));
  const appsQuery = useQuery(computerAppsQueryOptions(environmentId, null, hasBox));
  // "Uses AI" on a tile's tooltip; read once, Settings → Apps keeps polling.
  const appAiQuery = useQuery({ ...appAiQueryOptions(environmentId), refetchInterval: false });
  const browserOnMachine =
    typeof window !== "undefined" && isBrowserOnMachine(window.location.hostname);

  const tiles = useMemo(
    () =>
      withAiNotes(
        buildProgramTiles({
          machineApps: machineAppsQuery.data?.apps ?? [],
          storeApps: appsQuery.data?.installed.apps ?? [],
          installs: [],
          browserOnMachine,
          computerOn,
        }),
        appAiQuery.data?.apps,
      ),
    [appAiQuery.data, appsQuery.data, browserOnMachine, computerOn, machineAppsQuery.data],
  );

  return {
    tiles,
    loading: machineAppsQuery.isPending || (hasBox && appsQuery.isPending),
    hasStore: hasBox && Boolean(stateQuery.data?.linked),
  };
}

/** Origin of an address, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
