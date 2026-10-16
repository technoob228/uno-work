/**
 * The launcher's Apps list (w0138): the person's apps on every computer they
 * have connected, not only the one on screen — "Пульт on uno-product, the
 * mail dashboard on this Mac". Same sources and rules as the desktop
 * (`buildProgramTiles`, `appPrimaryAction`); the store apps of a cloud
 * computer stay on its Apps & sites page.
 */
import type { EnvironmentId, UnoMachineApps } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { demoDesktop } from "../../demo/demoFlag";
import { isElectron } from "../../env";
import { useMachineRows } from "../../hooks/useMachineRows";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import { machineAppsQueryOptions } from "../computer/computerQueries";
import { buildProgramTiles } from "../computer/programModel";
import { type LauncherAppRow, launcherAppState, sortLauncherApps } from "./panelLauncher.logic";

export function useLauncherApps(): {
  readonly rows: ReadonlyArray<LauncherAppRow>;
  readonly loading: boolean;
} {
  const machines = useMachineRows();
  const online = useMemo(
    () =>
      machines.flatMap((row) =>
        row.environmentId !== null && row.status !== "sleeping" && row.status !== "offline"
          ? [{ environmentId: row.environmentId, label: row.label, isPrimary: row.isPrimary }]
          : [],
      ),
    [machines],
  );
  const results = useQueries({
    queries: online.map((machine) =>
      machineAppsQueryOptions(machine.environmentId as EnvironmentId),
    ),
    combine: (all) => ({
      data: all.map((result) => result.data as UnoMachineApps | undefined),
      loading: all.some((result) => result.isPending),
    }),
  });

  const rows = useMemo(() => {
    const list: LauncherAppRow[] = [];
    online.forEach((machine, index) => {
      const apps = results.data[index]?.apps ?? [];
      // localhost addresses open only in the desktop app on this very computer.
      const browserOnMachine = machine.isPrimary && (isElectron || demoDesktop());
      const tiles = buildProgramTiles({
        machineApps: apps,
        storeApps: [],
        installs: [],
        browserOnMachine,
        computerOn: true,
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
          url: action.kind === "open" && !action.disabled ? action.url : null,
        });
      }
    });
    return sortLauncherApps(list);
  }, [online, results.data]);

  return { rows, loading: results.loading && rows.length === 0 };
}
