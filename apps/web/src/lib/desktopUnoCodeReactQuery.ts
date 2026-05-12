import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { UnoCodeInstallState } from "@t3tools/contracts";

export const desktopUnoCodeQueryKeys = {
  all: ["desktop", "uno-code"] as const,
  state: () => ["desktop", "uno-code", "state"] as const,
};

export const setDesktopUnoCodeInstallStateQueryData = (
  queryClient: QueryClient,
  state: UnoCodeInstallState | null,
) => queryClient.setQueryData(desktopUnoCodeQueryKeys.state(), state);

export function desktopUnoCodeInstallStateQueryOptions() {
  return queryOptions({
    queryKey: desktopUnoCodeQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getUnoCodeInstallState !== "function") return null;
      return bridge.getUnoCodeInstallState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopUnoCodeInstallState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopUnoCodeInstallStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onUnoCodeInstallState !== "function") return;

    return bridge.onUnoCodeInstallState((nextState) => {
      setDesktopUnoCodeInstallStateQueryData(queryClient, nextState);
    });
  }, [queryClient]);

  return query;
}
