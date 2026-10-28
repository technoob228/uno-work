/**
 * Each computer's "On all my computers" status, asked of its own daemon
 * (each one syncs its own projects). A computer whose Uno Work is older
 * simply has no marks.
 *
 * @module projectSync/useProjectSync
 */
import type { EnvironmentId, ProjectSyncEntry, ProjectSyncSnapshot } from "@t3tools/contracts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { entriesByProject, refreshEveryMs } from "./projectSync.logic";

export const projectSyncQueryKey = (environmentId: EnvironmentId) =>
  ["projectSync", environmentId] as const;

export function useProjectSyncStatuses(environmentIds: ReadonlyArray<EnvironmentId>) {
  const unique = useMemo(() => [...new Set(environmentIds)].toSorted(), [environmentIds]);
  const results = useQueries({
    queries: unique.map((environmentId) => ({
      queryKey: projectSyncQueryKey(environmentId),
      queryFn: async (): Promise<ProjectSyncSnapshot> => {
        const api = readEnvironmentApi(environmentId);
        if (!api) throw new Error("This computer isn't connected.");
        return api.projectSync.status();
      },
      retry: false,
      staleTime: 1_500,
      refetchInterval: (query: { state: { data: ProjectSyncSnapshot | undefined } }) =>
        refreshEveryMs(query.state.data),
    })),
  });
  const statuses = unique.map((environmentId, index) => ({
    environmentId,
    status: results[index]?.data,
  }));
  const entries = entriesByProject(statuses);
  return { statuses, entries };
}

export function useRefreshProjectSync() {
  const queryClient = useQueryClient();
  return useCallback(
    (environmentId: EnvironmentId, entry?: ProjectSyncEntry) => {
      if (entry) {
        queryClient.setQueryData<ProjectSyncSnapshot>(projectSyncQueryKey(environmentId), (old) =>
          old
            ? {
                ...old,
                projects: [
                  ...old.projects.filter((item) => item.projectId !== entry.projectId),
                  entry,
                ],
              }
            : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: projectSyncQueryKey(environmentId) });
    },
    [queryClient],
  );
}
