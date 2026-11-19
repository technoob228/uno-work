/**
 * The apps of every computer of the workspace that is on — for the app
 * window, which opens an app on whichever computer it is (workspaceApps.ts).
 * Shares the per-computer query with Home and the sidebar, so the active
 * computer's apps are not asked for twice.
 */
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useMachineRows } from "../../hooks/useMachineRows";
import { machineAppsQueryOptions } from "../computer/computerQueries";
import type { WorkspaceComputer } from "./workspaceApps";

export function useWorkspaceComputers(): {
  readonly computers: ReadonlyArray<WorkspaceComputer>;
  readonly loading: boolean;
} {
  const rows = useMachineRows();
  const online = useMemo(
    () =>
      rows.flatMap((row) =>
        row.environmentId !== null && row.status === "online"
          ? [{ environmentId: row.environmentId, label: row.label, kind: row.kind }]
          : [],
      ),
    [rows],
  );
  // `combine` is structurally shared: the same lists keep the same identity.
  const { appLists, loading } = useQueries({
    queries: online.map((row) => machineAppsQueryOptions(row.environmentId)),
    combine: (results) => ({
      appLists: results.map((result) => result.data?.apps ?? []),
      loading: results.some((result) => result.isPending),
    }),
  });
  const computers = useMemo(
    () => online.map((row, index) => ({ ...row, online: true, apps: appLists[index] ?? [] })),
    [online, appLists],
  );
  return { computers, loading };
}
