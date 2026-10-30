/**
 * The computer's apps as tiles, for surfaces other than the home screen: the
 * sidebar's Apps list and the in-Uno app view (which only frames addresses
 * that belong to this computer). Same sources and rules as the desktop
 * (`buildProgramTiles`); installs in progress stay a home-screen concern.
 */
import type { UnoComputerAppTemplate } from "@t3tools/contracts";
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
  /** For the built-in tiles that install from the store (Uno Notetaker). */
  readonly computer: {
    readonly loading: boolean;
    readonly linked: boolean;
    readonly hasBox: boolean;
    readonly computerOn: boolean;
    /** The store's catalog; undefined while it is read or when it isn't there. */
    readonly templates: ReadonlyArray<UnoComputerAppTemplate> | undefined;
  };
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
          publishBlockedReason: machineAppsQuery.data?.publishBlockedReason ?? null,
        }),
        appAiQuery.data?.apps,
      ),
    [appAiQuery.data, appsQuery.data, browserOnMachine, computerOn, machineAppsQuery.data],
  );

  return {
    tiles,
    loading: machineAppsQuery.isPending || (hasBox && appsQuery.isPending),
    hasStore: hasBox && Boolean(stateQuery.data?.linked),
    computer: {
      loading: stateQuery.isPending,
      linked: Boolean(stateQuery.data?.linked),
      hasBox,
      computerOn,
      templates: catalogTemplates(appsQuery.data?.catalog),
    },
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

/** The catalog's templates once it answered (an empty list when it can't); undefined while read. */
export function catalogTemplates(
  catalog:
    | { readonly availability: string; readonly templates: ReadonlyArray<UnoComputerAppTemplate> }
    | undefined,
): ReadonlyArray<UnoComputerAppTemplate> | undefined {
  if (!catalog) return undefined;
  return catalog.availability === "ok" ? catalog.templates : [];
}
