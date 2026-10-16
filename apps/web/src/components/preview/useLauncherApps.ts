/**
 * The launcher's Apps list (w0138): the person's apps on every computer they
 * have connected, not only the one on screen — "Пульт on uno-product, the
 * mail dashboard on this Mac". Same sources and rules as the desktop
 * (`buildProgramTiles`, `appPrimaryAction`): what the daemon runs
 * (`machineApps`) plus, on an Uno cloud computer, what was installed from the
 * App Store (as `useProgramTiles` does for the computer on screen).
 *
 * A computer that doesn't answer (asleep, offline, an old Uno Work without
 * the RPC) adds no rows; if none answered and there are no rows, `failed`
 * says so — the list then says "couldn't load" instead of "no apps yet".
 */
import type { EnvironmentId, UnoComputerApps, UnoMachineApps } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { demoDesktop } from "../../demo/demoFlag";
import { isElectron } from "../../env";
import { useMachineRows } from "../../hooks/useMachineRows";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import { computerAppsQueryOptions, machineAppsQueryOptions } from "../computer/computerQueries";
import { buildProgramTiles, isBrowserOnMachine } from "../computer/programModel";
import { type LauncherAppRow, launcherAppState, sortLauncherApps } from "./panelLauncher.logic";

export function useLauncherApps(): {
  readonly rows: ReadonlyArray<LauncherAppRow>;
  readonly loading: boolean;
  /** Every computer asked failed and there is nothing to show. */
  readonly failed: boolean;
} {
  const machines = useMachineRows();
  const online = useMemo(
    () =>
      machines.flatMap((row) =>
        row.environmentId !== null && row.status !== "sleeping" && row.status !== "offline"
          ? [
              {
                environmentId: row.environmentId,
                label: row.label,
                isPrimary: row.isPrimary,
                hasBox: row.box !== null,
              },
            ]
          : [],
      ),
    [machines],
  );
  const machineApps = useQueries({
    queries: online.map((machine) =>
      machineAppsQueryOptions(machine.environmentId as EnvironmentId),
    ),
    combine: (all) => ({
      data: all.map((result) => result.data as UnoMachineApps | undefined),
      loading: all.some((result) => result.isPending),
      failed: all.length > 0 && all.every((result) => result.isError),
    }),
  });
  // App Store installs live on the cloud computer's Apps & sites, and show
  // here too (as in the 0.0.137 launcher, for the computer on screen).
  const storeApps = useQueries({
    queries: online.map((machine) =>
      computerAppsQueryOptions(machine.environmentId as EnvironmentId, null, machine.hasBox),
    ),
    combine: (all) => all.map((result) => result.data as UnoComputerApps | undefined),
  });

  const rows = useMemo(() => {
    const list: LauncherAppRow[] = [];
    // localhost addresses open only where this page runs on that very
    // computer: the desktop app, or a browser on the computer itself.
    const pageOnPrimary =
      isElectron ||
      demoDesktop() ||
      (typeof window !== "undefined" && isBrowserOnMachine(window.location.hostname));
    online.forEach((machine, index) => {
      const apps = machineApps.data[index]?.apps ?? [];
      const installed = machine.hasBox ? (storeApps[index]?.installed.apps ?? []) : [];
      const tiles = buildProgramTiles({
        machineApps: apps,
        storeApps: installed,
        installs: [],
        browserOnMachine: machine.isPrimary && pageOnPrimary,
        computerOn: true,
        publishBlockedReason: machineApps.data[index]?.publishBlockedReason ?? null,
      });
      for (const tile of tiles) {
        const action = appPrimaryAction(tile);
        list.push({
          key: `${machine.environmentId}:${tile.key}`,
          name: tile.name,
          icon: tile.icon,
          iconImage: tile.iconImage,
          templateId: tile.templateId ?? null,
          computer: machine.label,
          state: launcherAppState(tile.status),
          url: action.kind === "open" && !action.disabled ? (action.url ?? null) : null,
        });
      }
    });
    return sortLauncherApps(list);
  }, [online, machineApps.data, storeApps]);

  return {
    rows,
    loading: machineApps.loading && rows.length === 0,
    failed: machineApps.failed && rows.length === 0,
  };
}
